import { GoalViews, GOAL_MODE } from "./inbox-goals.js";
import { div } from "gpui-kit";
import { PreviewInbox } from "./decision-preview.js";
import { SnapshotInbox } from "./snapshot-preview.js";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec, run, notify, settings, agents, panes, terminals, shared, setShared } from "herdr";
import { loadClaudeQuotas } from "./accounts.js";
import { accountFor, contextOfPath, inFocus } from "./context.js";
import { ago, nextSince } from "./lib/time.js";
import { today, duration } from "./ledger.js";
import { openReview } from "./review.js";
import { openHandoff } from "./handoff.js";
import { openReplies } from "./replies.js";
import { button, sectionHeader, spinner, withKey, foldRow, FOLDS, shortcutBindings } from "./ui.js";
import { ShortcutHelp } from "./shortcut-help.js";
import { INBOX_SHORTCUT_ACTIONS } from "./lib/shortcut-help.js";
import { agentPRs, seconds, recent } from "./lib/github.js";
import { isAddressed } from "./lib/addressed.js";
import { GIT_READ, githubRepo, withoutLogin } from "./lib/git.js";
import { STATS_FOR } from "./lib/refresh.js";
import { readPrompt, samePrompt, sameChoicesBut, submitKeys, freeOption, moveKeys, lastMessage, reasonOf } from "./lib/prompt.js";
import { COUNT, showPanel } from "./toolbar.js";
import { launched } from "./skills.js";
import { openWeek } from "./week.js";
import { PrViews } from "./inbox-prs.js";
import { TreeViews } from "./inbox-trees.js";
import { KeyNav, INBOX_FOCUS } from "./inbox-keys.js";
import { LiveViews } from "./inbox-live.js";
import { LocalAddressed } from "./inbox-addressed.js";
import { AwayViews } from "./inbox-away.js";
import { DesktopViews } from "./inbox-desktop.js";
import { LandViews, LANDING } from "./inbox-land.js";
import { isSettled } from "./lib/desktop.js";

// How long a send waits for its dialog to go, in 250 ms reads.
const SETTLE_TRIES = 8;
// A send whose hc call never came back would hold the agent's turn, and every later click, for good.
// Mods have no setTimeout, so the turn is let go by age rather than by a timer.
const SEND_STALE = 20000;
// How long a card says its question is a new one, after an answer brought it.
const NEXT_FOR = 8000;
const LOCAL_STUCK = 60000;
const HEAD_FOR = 15000;
const hc = (args) => exec("hc", args);
// Lines of a command, diff or plan a card shows.
const ASK_LINES = 8;
// Why each waiting agent waits: address -> a short line, for the agents list.
const REASONS = "relevo.reasons";
const AGENT_PRS = "relevo.agentPRs";

// Local work, pull requests and merged worktrees in one list; the PR and worktree parts live in their own files.
function savedSince() {
  try {
    return JSON.parse(localStorage.getItem("since")) ?? {};
  } catch {
    return {};
  }
}

export class Inbox {
  init(_props, cx) {
    if (_props?.syntheticPreview === true) {
      this.preview = _props?.snapshotPreview === true ? new SnapshotInbox() : new PreviewInbox();
      this.preview.init(_props, cx);
      return;
    }
    this.local = [];
    this.h = cx.focus_handle();
    this.shortcutHelp = new ShortcutHelp();
    this.shortcutHelp.init({
      actions: INBOX_SHORTCUT_ACTIONS,
      onClose: (cx) => { this.goalHelp = false; this.h.focus(); cx.notify(); },
    }, cx);
    this.sel = null;
    // An old request must not steal the keyboard when this copy starts.
    this.focusAt = shared(INBOX_FOCUS)?.at ?? null;
    this.mine = [];
    this.ready = [];
    this.requested = [];
    this.prAgents = {};
    this.origins = new Map();
    this.clones = {};
    this.expanded = { ...(shared(FOLDS) ?? {}) };
    this.quotas = {};
    this.prsAt = 0;
    this.addressed = {};
    this.worktrees = [];
    this.confirm = null;
    this.wtError = {};
    this.removing = new Set();
    this.gone = new Set();
    this.since = savedSince();
    this.tops = new Map();
    this.stats = new Map();
    // What each waiting agent asks, read once per wait: address -> { since, prompt }.
    this.prompts = new Map();
    // A note to send right after the answer: address -> text.
    this.notes = new Map();
    this.answering = new Map();
    this.nextAt = new Map();
    this.reply = InputState.new({ value: "", placeholder: "Reply · Enter sends, Esc cancels" });
    this.reply.on("submit", (_e, cx) => this.sendReply(cx));
    this.today = [];
    this.digest = null;
    const panels = (shared("workspace.panels") ?? ["files", "changes"]).filter((p) => p !== "review");
    if (!panels.includes("inbox")) setShared("workspace.panels", [...panels, "inbox"]);
    this.labelling = {};
    this.terms = new Map();
    this.startGoals(cx);
    this.startLive(cx);
    this.scanLocal(cx);
    this.loadAddressed(cx);
    this.scanPRs(cx);
    this.loadQuotas(cx);
    this.scanTrees(cx);
    this.startLand(cx);
    // These feed alerts, so they keep running behind other apps.
    cx.timer.every(180000, (cx) => this.scanPRs(cx));
    cx.timer.every(60000, (cx) => this.loadQuotas(cx));
  }

  todayGroup(t, list) {
    const total = list.reduce((n, d) => n + d.seconds, 0);
    return [
      foldRow(this, t, "today-time", "today", `Agent time today${total > 0 ? ` · ${duration(total)}` : ""}`, {
        gap: true,
        after: h_flex().flex_1().justify_end()
          .child(button(t, "week-open", "Week", () => openWeek(), { size: "sm", tip: "Agent time per ticket and day" })),
      }),
      v_flex().children((this.expanded.today ? list : []).map((d) => h_flex().id(`day-${d.key}`).h(24).px(8).gap(8).items_center().rounded(6)
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(d.key))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(duration(d.seconds))))),
    ];
  }

  // Today's tokens, read again when the sidebar's scan writes a new report.
  loadQuotas(cx) {
    cx.spawn(async (cx) => {
      const quotas = await loadClaudeQuotas();
      if (JSON.stringify(quotas) === JSON.stringify(this.quotas)) return;
      this.quotas = quotas;
      cx.notify();
    });
  }

  seen(pr) {
    const l = this.launchedMap()[pr.url];
    return Boolean(l) && seconds(pr.updatedAt) <= l.at;
  }

  // Addressed PRs leave the lists (and the count) and fold under one line per group.
  shown() {
    const pr = (p) => inFocus(accountFor(p.repo)), open = (p) => pr(p) && !isAddressed(p, this.addressed);
    const done = (p) => pr(p) && isAddressed(p, this.addressed);
    const local = this.local.filter((i) => inFocus(contextOfPath(i.top)));
    const off = (i) => i.kind === "diff" && Boolean(this.addressedLabel(i.agent.address));
    const desktop = this.desktopSessions();
    return {
      desktop: desktop.filter((s) => !isSettled(s, this.addressed)), desktopDone: desktop.filter((s) => isSettled(s, this.addressed)),
      local: local.filter((i) => !off(i)), localDone: local.filter(off),
      mine: this.mine.filter(open), requested: this.requested.filter(open),
      ready: this.ready.filter(open),
      mineDone: [...this.mine, ...this.ready].filter(done), requestedDone: this.requested.filter(done),
      worktrees: this.worktrees.filter((w) => inFocus(contextOfPath(w.main))),
      today: this.today.filter((d) => inFocus(contextOfPath(d.repo))),
    };
  }

  publish(v = this.shown()) {
    const open = (list) => list.filter((p) => recent(p) && !p.fresh && !this.seen(p) && !(this.launchedMap()[p.url] && this.prBusy(p))).length;
    const n = this.openReviews().length + v.local.length + v.desktop.filter((s) => s.state === "blocked").length + open(v.mine) + open(v.requested);
    if (shared(COUNT) !== n) setShared(COUNT, n);
    this.publishReasons();
    this.publishAgentPRs();
    this.publishSettled();
  }

  publishAgentPRs() {
    const now = agentPRs(this.places ?? [], this.prAgents, this.openPRs ?? []);
    if (JSON.stringify(shared(AGENT_PRS) ?? {}) !== JSON.stringify(now)) setShared(AGENT_PRS, now);
  }

  waitingReasons() {
    const report = new Map(terminals().map((k) => [k.address, k.report]));
    return Object.fromEntries((this.local ?? []).filter((i) => i.kind === "blocked")
      .map((i) => [i.agent.address, reasonOf(i.prompt, report.get(i.agent.address))]));
  }

  publishReasons() {
    const now = this.waitingReasons();
    if (JSON.stringify(shared(REASONS) ?? {}) !== JSON.stringify(now)) setShared(REASONS, now);
  }

  // A scan stuck on a call that never came back stops blocking the next one after LOCAL_STUCK.
  scanLocal(cx) {
    if (this.scanning && Date.now() - this.localAt < LOCAL_STUCK) {
      this.again = true;
      return;
    }
    this.scanning = true;
    this.again = false;
    this.localAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const byPane = new Map(panes().map((p) => [p.pane, p]));
        const byTab = new Map(Object.entries(launched()).map(([url, l]) => [l.tab, url]));
        const seen = new Set(), items = [], prAgents = {}, all = agents();
        this.readLabels(all, cx);
        // Agents carry no timestamps, so a card's age is how long this status has been seen.
        const since = nextSince(this.since, all, Date.now() / 1000);
        if (JSON.stringify(since) !== JSON.stringify(this.since)) localStorage.setItem("since", JSON.stringify(since));
        this.since = since;
        // A saved age outlives an absence, so it can't vouch for the question read before it.
        const listed = new Set(all.map((a) => a.address));
        for (const address of this.prompts.keys()) if (!listed.has(address)) this.prompts.delete(address);
        // A repo's one card goes to an agent not marked addressed, if it has one.
        const marked = (a) => (this.addressedLabel(a.address) ? 1 : 0);
        const places = [];
        for (const a of all) {
          const pane = byPane.get(a.pane);
          if (a.address.includes("/") || !pane?.cwd) continue;
          if (!this.tops.has(pane.cwd)) {
            this.tops.set(pane.cwd, (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pane.cwd })).stdout.trim());
          }
          const top = this.tops.get(pane.cwd);
          // A worktree's folder isn't named after its repo, so origin says which it is.
          if (top && !this.origins.has(top)) {
            this.origins.set(top, githubRepo(withoutLogin((await exec("git", ["-C", top, "remote", "get-url", "origin"])).stdout)));
          }
          const head = top ? await this.headOf(top) : "";
          places.push({ address: a.address, repo: this.origins.get(top), branch: pane.branch, head });
        }
        this.places = places;
        for (const a of [...all].sort((x, y) => marked(x) - marked(y))) {
          const url = byTab.get(a.tab_name);
          if (url) {
            prAgents[url] = a;
            if (a.status !== "blocked") continue;
          }
          if (a.address.includes("/") || a.status === "working") continue;
          const pane = byPane.get(a.pane);
          if (!pane?.cwd) continue;
          const top = this.tops.get(pane.cwd);
          const repo = top.split("/").pop() || a.space_name;
          if (a.status === "blocked") {
            const at = since[`${a.address}:blocked`];
            if (this.prompts.get(a.address)?.since !== at) {
              const screen = (await hc(["read", a.address, "--lines", "0"])).stdout;
              const prompt = readPrompt(screen);
              this.prompts.set(a.address, { since: at, prompt, free: freeOption(prompt) });
            }
            items.push({ kind: "blocked", agent: a, top, repo, branch: pane.branch, prompt: this.prompts.get(a.address).prompt });
            continue;
          }
          if (!top || seen.has(top)) continue;
          seen.add(top);
          // The diff of a resting agent only changes when its status does; re-read it at most once a minute otherwise.
          let cached = this.stats.get(top);
          if (!cached || this.dirty.delete(top) || cached.status !== a.status || Date.now() - cached.at > STATS_FOR) {
            const stat = (await exec("git", [...GIT_READ, "diff", "HEAD", "--shortstat"], { cwd: top })).stdout;
            const untracked = (await exec("git", [...GIT_READ, "ls-files", "--others", "--exclude-standard"], { cwd: top }))
              .stdout.split("\n").filter(Boolean).length;
            // What the agent said last, so the card tells whether to review or to answer it.
            const said = lastMessage((await hc(["read", a.address, "--lines", "20"])).stdout);
            this.stats.set(top, cached = { status: a.status, at: Date.now(), stat, untracked, said });
          }
          const { stat, untracked, said } = cached;
          const files = Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0) + untracked;
          if (!files) continue;
          items.push({
            kind: "diff", agent: a, top, repo, branch: pane.branch, files, said,
            add: Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0), del: Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0),
          });
        }
        this.prAgents = prAgents;
        this.today = await today();
        for (const i of items) i.at = since[`${i.agent.address}:${i.agent.status}`];
        const local = items.sort((x, y) => (x.kind === "blocked" ? 0 : 1) - (y.kind === "blocked" ? 0 : 1) || y.at - x.at);
        // Redraw only when a card or today's time changed, not on every scan.
        const sign = JSON.stringify([
          local.map((i) => [i.agent.address, i.kind, i.files, i.add, i.del, i.said, Math.floor(i.at / 60), this.addressedLabel(i.agent.address)]),
          this.today,
        ]);
        this.local = local;
        this.publishReasons();
        this.publishAgentPRs();
        await this.watchRepos(seen, cx);
        if (sign !== this.sign) {
          this.sign = sign;
          this.publish();
          cx.notify();
        }
        this.localError = null;
      } catch (e) {
        // Said in the Inbox: a scan that throws would otherwise leave the cards as they were, silently.
        this.localError = `Agents: ${String(e?.message ?? e).split("\n")[0]}`;
        cx.notify();
      } finally {
        this.scanning = false;
      }
      // A change seen mid-scan may have been read too early.
      if (this.again) this.scanLocal(cx);
    });
  }

  // A repo's HEAD, kept for HEAD_FOR or until its git folder says it changed; several agents share one.
  async headOf(top) {
    this.heads ??= new Map();
    const kept = this.heads.get(top);
    if (kept && Date.now() - kept.at < HEAD_FOR && !this.dirty.has(top)) return kept.head;
    const head = (await exec("git", [...GIT_READ, "-C", top, "rev-parse", "HEAD"])).stdout.trim();
    this.heads.set(top, { head, at: Date.now() });
    return head;
  }

  card(t, id, hot, head, meta, actions) {
    if (this.hiddenIds?.has(id)) return null;
    const sel = this.selected(id);
    return v_flex().id(id).p(10).gap(6).rounded(9).bg(sel ? t.selected : t.background).border_1()
      .border_color(sel ? t.accent : hot ? t.blocked : t.border)
      .child(head)
      .child(meta)
      .child(h_flex().flex_wrap().gap(5).children(actions));
  }

  // What a card does most stays in sight; the rest folds behind ⋯ once it's more than one button.
  foldActions(t, id, actions, mark = null) {
    const last = mark ? [mark] : [], extra = actions.slice(2);
    if (extra.length < 2) return [...actions, ...last];
    const key = `more-${id}`, open = this.expanded[key];
    return [...actions.slice(0, 2), ...last, button(t, key, "⋯", (cx) => {
      this.expanded[key] = !open;
      cx.notify();
    }, { tip: open ? "Fewer actions" : "More actions" }), ...(open ? extra : [])];
  }

  head(t, dot, title, when, ci = null, threads = 0) {
    const ring = dot === "ring";
    return h_flex().gap(7).items_center().min_w(0)
      .child(div().size(7).flex_none().rounded_full()
        .when(ring, (el) => el.border_1().border_color(t.dim))
        .when(!ring, (el) => el.bg(dot)))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(title))
      .when(threads > 0, (el) => el.child(this.threadBadge(t, threads, title)))
      .when(Boolean(ci), (el) => el.child(this.ciBadge(t, ci, title)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(when));
  }

  close() {
    if (this.preview) return this.preview.close();
    this.reply.release();
    this.shortcutHelp?.close();
    this.wanted.clear();
  }

  // Long lines wrap: a cut command could hide the part that matters.
  askBlock(t, ask, address) {
    const head = [ask.title, ask.about].filter(Boolean).join(" · "), key = `ask-${address}`;
    const more = this.expanded[key] ? 0 : ask.body.length - ASK_LINES;
    const mono = (el) => el.font_family(settings().font_family ?? "JetBrains Mono").text_size(11);
    return v_flex().gap(3)
      .when(Boolean(head), (el) => el.child(div().text_size(11).text_color(t.muted).child(head)))
      .when(ask.body.length > 0, (el) => el.child(mono(v_flex().min_w(0).px(8).py(5).rounded(6).bg(t.raised).text_color(t.foreground))
        .when(Boolean(ask.cut), (b) => b.child(div().text_color(t.dim).child("… starts above the screen")))
        .children((more > 0 ? ask.body.slice(0, ASK_LINES) : ask.body).map((l) => div().min_w(0).child(l)))
        .when(more > 0, (b) => b.child(div().id(`${key}-more`).cursor_pointer().text_color(t.accent)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.expanded[key] = true;
            cx.notify();
          })
          .child(`+${more} more ${more === 1 ? "line" : "lines"}`)))));
  }

  // A waiting agent's question and its choices as a list: a click answers (or checks, in a multiple choice).
  waitingCard(t, item, goAgent) {
    const a = item.agent, p = item.prompt ?? { question: "", options: [] }, replying = this.replying === a.address;
    const free = this.prompts.get(a.address)?.free;
    const row = (o) => h_flex().id(`answer-${a.address}-${o.n}`).h(24).px(6).gap(7).items_center().rounded(5)
      .cursor_pointer()
      .when(p.cursor === o.n, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover))
      .tooltip(o.detail ? `${o.label} · ${o.detail}` : o.label)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.answer(a, o, cx, p);
      })
      .child(div().w(12).flex_none().text_size(11).text_color(t.dim).child(String(o.n)))
      .when("checked" in o, (el) => el.child(div().flex_none().text_size(13)
        .text_color(o.checked ? t.accent : t.dim).child(o.checked ? "☑" : "☐")))
      .child(div().flex_none().max_w(200).truncate().text_size(13).text_color(t.foreground)
        .child(o.n === free && /^type something/i.test(o.label) ? "Type something…" : o.label))
      .when(Boolean(o.detail), (el) => el.child(
        div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(o.detail)));
    const actions = [
      ...(p.submit ? [button(t, `submit-${a.address}`, "Submit", (cx) => this.submit(a, p, cx), { kind: "solid" })] : []),
      ...(p.options.length || p.unparsed
        ? []
        : [button(t, `reply-${a.address}`, "Reply", (cx) => this.startReply(a, null, cx), { kind: "solid" })]),
      button(t, `go-${a.address}`, p.options.length ? "Agent" : "Go to agent", goAgent),
      ...(p.options.length
        ? [button(t, `note-${a.address}`, "Note", (cx) => this.startReply(a, null, cx, "note"), {
          tip: "Sent to the agent right after your answer",
        })]
        : []),
      button(t, `handoff-${a.address}`, "Continue with…", () => openHandoff(a.address)),
    ];
    return this.card(t, `in-${a.address}`, true,
      this.head(t, t.blocked, `${item.repo} · ${a.tab_name || item.branch || ""}`,
        this.sending(a.address) ? "Answering…" : Date.now() - (this.nextAt.get(a.address) ?? 0) < NEXT_FOR ? "Next question" : ago(item.at)),
      v_flex().gap(4)
        .when(Boolean(p.ask), (el) => el.child(this.askBlock(t, p.ask, a.address)))
        .child(v_flex().children((p.question || "Waiting for you").split("\n")
          .map((l) => div().truncate().text_size(13).text_color(t.foreground).child(l))))
        .when(Boolean(p.summary?.length), (el) => el.child(v_flex().gap(3).py(4).px(8).rounded(6).bg(t.raised)
          .children(p.summary.map((s) => v_flex()
            .child(div().truncate().text_size(11).text_color(t.muted).child(s.question))
            .child(div().truncate().text_size(13).text_color(t.foreground).child(`→ ${s.answer || "(no answer)"}`))))))
        .when(p.options.length > 0, (el) => el.child(v_flex().gap(1).children(p.options.map(row))))
        .when(Boolean(p.preview), (el) => el.child(div().px(8).py(5).rounded(6).border_1().border_color(t.border)
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted)
          .children(p.preview.split("\n").slice(0, 8).map((l) => div().truncate().child(l || " ")))))
        .when(this.notes.has(a.address), (el) => el.child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().child(`Note: ${this.notes.get(a.address)}`))
          .child(button(t, `note-clear-${a.address}`, "×", (cx) => {
            this.notes.delete(a.address);
            cx.notify();
          }, { size: "sm", tip: "Drop the note" }))))
        .when(replying, (el) => el.child(div().mt(2).h(28).px(8).flex().items_center().rounded(6).border_1()
          .border_color(t.accent).bg(t.background).child(Input.new(this.reply).h_full()))),
      replying ? [] : this.foldActions(t, `in-${a.address}`, actions));
  }

  // Measured on Claude's menus: in a single choice ↑/↓ then Enter answers in every variant (a number answers
  // at once in some and only moves the cursor in others, like the one with previews). In a multiple choice the
  // number toggles the box; when the cursor sits in the free-text choice it would be typed, so ↑ leaves first.
  answer(a, option, cx, seen) {
    if (option.n === this.prompts.get(a.address)?.free) return this.startReply(a, option.n, cx, "reply", seen);
    this.sendOnce(a.address, seen, cx, async ({ prompt: p, free }) => {
      if (!p.multi) return this.press(a, [...moveKeys(p, option.n), "enter"], option.label, cx);
      const leave = p.cursor != null && p.cursor === free ? ["up"] : [];
      return this.press(a, [...leave, String(option.n)], option.label, cx);
    }, seen?.multi);
  }

  submit(a, seen, cx) {
    this.sendOnce(a.address, seen, cx, async ({ prompt, free }) => {
      const leave = prompt.cursor != null && prompt.cursor === free ? ["up"] : [];
      // Leaving the field moves the cursor one up, so count the moves to Submit from there.
      const from = leave.length ? { ...prompt, cursor: prompt.cursor - 1 } : prompt;
      return this.press(a, [...leave, ...submitKeys(from)], "Submitted", cx);
    });
  }

  // One send per agent at a time: a second click's Enter would land in whatever dialog the first one reveals.
  // A box of a multiple choice doesn't move on to anything, so those clicks wait their turn.
  // A send still running, unless it has been stuck long enough to give up on.
  sending(address) {
    const held = this.answering.get(address);
    return held && Date.now() - held.at <= SEND_STALE ? held : null;
  }

  sendOnce(address, seen, cx, send, queue = false) {
    const busy = this.sending(address)?.turn;
    if (busy && !queue) return;
    let done;
    const turn = new Promise((resolve) => { done = resolve; });
    const mine = { turn, at: Date.now() };
    this.answering.set(address, mine);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await busy;
        if (await this.stillAsking(address, seen, cx)) await send(this.prompts.get(address), cx);
      } finally {
        if (this.answering.get(address) === mine) this.answering.delete(address);
        done();
        cx.notify();
      }
    });
  }

  // Keys only go to the question the card showed; if it changed, the card redraws with the new one.
  // A card without choices (no seen) only needs none to have appeared: a paste's Enter would pick one.
  async stillAsking(address, seen, cx) {
    if (!await this.rereadPrompt(address)) {
      notify({ title: "Could not read the agent's screen", body: "Nothing was sent.", level: "warning" });
      return false;
    }
    const now = this.prompts.get(address).prompt;
    const live = agents().find((a) => a.address === address)?.status === "blocked";
    if (live && (seen ? samePrompt(seen, now) : !now.options.length && !now.unparsed)) return true;
    notify({ title: "The question changed", body: "Nothing was sent. Read the card and answer again.", level: "warning" });
    cx.notify();
    return false;
  }

  // Holds the send's turn until the dialog it answered has gone, so a late click can't reach the next one.
  async settle(address, before, cx) {
    for (let i = 0; i < SETTLE_TRIES; i++) {
      await cx.sleep(250);
      await this.rereadPrompt(address);
      const now = this.prompts.get(address)?.prompt;
      if (!before?.options.length || before.multi || !now || !samePrompt(before, now)) return;
    }
  }

  // After a key the screen changes (a box checks, the next question shows), so read it again.
  async press(a, keys, label, cx) {
    const before = this.prompts.get(a.address)?.prompt;
    const r = await hc(["keys", a.address, ...keys]);
    if (r.code !== 0) {
      notify({ title: "Could not answer", body: r.stderr.trim().split("\n")[0], level: "warning" });
      return;
    }
    await this.settle(a.address, before, cx);
    const after = this.prompts.get(a.address)?.prompt;
    if (after?.options.length && before && !samePrompt(before, after)) this.nextAt.set(a.address, Date.now());
    cx.notify();
    await this.sendNote(a);
    if (!this.prompts.get(a.address)?.prompt.multi) {
      notify({ title: `Answered ${a.tab_name || a.address}`, body: label, level: "success", timeout: 2000 });
    }
    this.scanLocal(cx);
  }

  // Claude's own notes field sends the answer without a choice when its Enter is pressed (measured), so a note
  // goes as a message once the question is gone; Claude queues it if the agent is already working.
  async sendNote(a) {
    const note = this.notes.get(a.address);
    const now = this.prompts.get(a.address)?.prompt;
    if (!note || now?.options.length || now?.unparsed) return;
    this.notes.delete(a.address);
    const r = await hc(["send", a.address, `Note on my last answer: ${note}`]);
    if (r.code !== 0) notify({ title: "Could not send the note", body: r.stderr.trim().split("\n")[0], level: "warning" });
  }

  // False when there's no screen to go by; what the card knows stays as it was.
  async rereadPrompt(address) {
    const r = await hc(["read", address, "--lines", "0"]);
    if (r.code !== 0 || !r.stdout.trim()) return false;
    const was = this.prompts.get(address);
    const prompt = readPrompt(r.stdout);
    this.prompts.set(address, { since: was?.since, prompt, free: freeOption(prompt, was?.free) });
    for (const i of this.local) if (i.agent.address === address) i.prompt = this.prompts.get(address).prompt;
    return true;
  }

  startReply(a, key, cx, mode = "reply", seen = null) {
    this.replying = a.address;
    this.replyKey = key;
    this.replyMode = mode;
    this.replySeen = seen;
    this.reply.set_value("");
    this.reply.focus();
    cx.notify();
  }

  // The free-text choice, as Claude's menu takes it (measured): in a single choice its number puts the cursor
  // in the field and a paste with Enter answers. In a multiple choice the number only toggles the box, so the
  // cursor moves there by arrows; the paste's Enter unchecks the box, so ↑ leaves the field and the number
  // checks it again. hc keys can't type accents, so the words always go as a paste.
  sendReply(cx) {
    const text = this.reply.value().trim(), address = this.replying, key = this.replyKey, mode = this.replyMode;
    const seen = this.replySeen;
    if (mode !== "note" && text && this.sending(address)) {
      notify({ title: "Still answering this agent", body: "Nothing was sent. Try again in a moment.", level: "warning" });
      return;
    }
    this.replying = null;
    this.replyKey = null;
    this.replyMode = null;
    if (mode === "note" && address) {
      if (text) this.notes.set(address, text);
      return cx.notify();
    }
    cx.notify();
    if (!text || !address) return;
    this.sendOnce(address, seen, cx, async ({ prompt: p }, cx) => {
      const failed = (r) => {
        if (!r || r.code === 0) return false;
        notify({ title: "Could not reply", body: r.stderr.trim().split("\n")[0], level: "warning" });
        return true;
      };
      const keys = (list) => (list.length ? hc(["keys", address, ...list]) : null);
      const moved = key && p?.multi ? await keys(moveKeys(p, key)) : key && p?.cursor !== key ? await keys([String(key)]) : null;
      if (failed(moved)) return;
      if (failed(await hc(["send", "--force", address, text]))) return;
      if (key && p?.multi) {
        await cx.sleep(250);
        await this.rereadPrompt(address);
        const now = this.prompts.get(address)?.prompt;
        if (now && sameChoicesBut(key, p, now)) await keys(now.options.find((o) => o.n === key)?.checked ? ["up"] : ["up", String(key)]);
      }
      await this.settle(address, p, cx);
      cx.notify();
      this.scanLocal(cx);
    });
  }

  localCard(t, item, addressed = false) {
    const a = item.agent;
    const goAgent = () => run("agent.focus", { terminal: a.address });
    if (item.kind === "blocked") return this.waitingCard(t, item, goAgent);
    return this.card(t, `in-${a.address}`, false,
      this.head(t, a.status === "done" ? t.done : t.idle, `${item.repo}${item.branch ? ` · ${item.branch}` : ""}`, ago(item.at)),
      v_flex().gap(3)
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.muted)
          .child(`${item.files} ${item.files === 1 ? "file" : "files"}`)
          .child(div().text_color(t.ansi2).child(`+${item.add}`))
          .child(div().text_color(t.ansi1).child(`−${item.del}`))
          .child(div().text_color(t.dim).child(a.status === "done" ? "agent finished" : "uncommitted")))
        .when(Boolean(item.said), (el) => el.child(div().id(`said-${a.address}`).truncate().text_size(11)
          .text_color(t.dim).italic().tooltip(item.said).child(`“${item.said}”`))),
      this.foldActions(t, `in-${a.address}`, [
        button(t, `review-${a.address}`, "Review", () => openReview(item.top, a.address), {
          kind: "solid", tip: withKey("Comment on the diff line by line", "relevo.review"),
        }),
        button(t, `agent-${a.address}`, "Agent", goAgent),
        this.sourceContextButton(t, `local:${item.top || a.address}`),
        button(t, `diff-${a.address}`, "View diff", () => {
          run("pane.focus", { pane: a.pane });
          showPanel("changes");
        }),
        button(t, `files-${a.address}`, "Files", () => {
          run("pane.focus", { pane: a.pane });
          showPanel("files");
        }),
        button(t, `reply-${a.address}`, "Reply", () => openReplies(a.address), {
          tip: withKey("Send it a message or a quick reply", "relevo.quick-reply"),
        }),
      ], addressed
        ? button(t, `undo-${a.address}`, "Undo", (cx) => this.setLocalAddressed(a, false, cx), { tip: "Back to the list" })
        : button(t, `addressed-${a.address}`, "✓", (cx) => this.setLocalAddressed(a, true, cx), {
          tip: "Addressed: hide until its agent works again",
        })));
  }

  localGroup(t, key, label, items, done = []) {
    if (!items.length && !done.length) return [];
    return [
      sectionHeader(t, label, items.length),
      ...items.map((i) => this.localCard(t, i)),
      ...this.addressedFold(t, key, done, (i) => this.localCard(t, i, true)),
    ];
  }

  render(cx) {
    if (this.preview) return this.preview.render(cx);
    this.snap = { launched: launched(), landing: shared(LANDING) ?? {} };
    try {
      return this.draw(cx);
    } finally {
      this.snap = null;
    }
  }

  draw(cx) {
    const t = theme(), v = this.shown();
    this.publish(v);
    this.takeFocus(cx);
    this.refreshGoals(cx);
    const goalMode = shared(GOAL_MODE) === true;
    this.goalProjection = this.projectGoals(v);
    this.nav = goalMode ? this.goalNav(this.goalProjection.ordered) : this.navItems(v);
    this.keyboard = this.h.is_focused();
    if (this.sel && !this.nav.some((i) => i.id === this.sel)) this.sel = null;
    const view = goalMode ? this.goalViewport() : this.viewport();
    this.hiddenIds = view.hidden;
    const part = (key, els) => (view.sections.has(key) ? [] : els.filter(Boolean));
    const total = this.openReviews().length + v.local.length + v.desktop.length + v.mine.length + v.requested.length;
    return v_flex().id("relevo-inbox").size_full().min_w(0).min_h(0).rounded(10).overflow_hidden()
      .on_size_change((size, context) => {
        const narrow = size.width < 350;
        if (this.narrowInbox !== narrow) { this.narrowInbox = narrow; context.notify(); }
      })
      .bg(t.surface ?? t.chrome).border_1().border_color(this.keyboard ? t.accent : t.border).text_color(t.foreground)
      .track_focus(this.h)
      .tab_index(0).role("group").accessibility_label(`${goalMode ? "Runs" : "Reviews"}. Arrow keys select work; Enter opens its primary action. Tab moves through controls.`)
      .on_key_down((e, cx) => this.navKey(e, cx))
      .child(h_flex().h(38).flex_none().px(8).gap(6).items_center()
        .when(goalMode, (el) => el.child(this.goalNewButton(t)))
        .child(div().flex_1())
        .child(button(t, "inbox-focus-list", "↕", () => this.h.focus(), { size: "sm", accessibleLabel: "Focus work queue", tip: "Focus the queue: arrow keys select, Enter opens" }))
        .child(button(t, "goal-key-help", "?", (cx) => {
          this.goalHelp = !this.goalHelp;
          if (this.goalHelp) this.shortcutHelp.focus();
          else this.h.focus();
          cx.notify();
        }, { size: "sm", tip: "Search keyboard shortcuts", accessibleLabel: "Keyboard help" }))
        .child(button(t, "inbox-refresh", !this.prsAt && this.scanningPRs ? [spinner(t.dim, 10)] : "↻", (cx) => {
          this.scanLocal(cx); this.scanPRs(cx); this.scanTrees(cx, true); this.loadGoals(cx);
        }, { size: "sm", accessibleLabel: "Refresh work", tip: `Refresh · ${this.prsAt ? `PRs ${ago(this.prsAt)}` : this.scanningPRs ? "PRs loading" : "PRs unavailable"}${this.error ? ` · ${this.error}` : ""}` })))
      .when(this.goalHelp, (el) => {
        this.shortcutHelp.setData(INBOX_SHORTCUT_ACTIONS, shortcutBindings());
        return el.child(this.shortcutHelp.render(t, cx));
      })
      .child(v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_size(11).text_color(t.blocked).child(this.error)))
        .when(Boolean(this.localError), (el) => el.child(div().id("local-error").p(8).text_size(11).text_color(t.blocked).child(this.localError)))
        .when(!goalMode && !total && !this.error && Boolean(this.prsAt), (el) => el.child(
          div().p(12).text_size(13).text_color(t.dim).child("Nothing waiting")))
        .when(view.above > 0, (el) => el.child(div().px(4).text_size(11).text_color(t.dim).child(`↑ ${view.above} above · Esc`)))
        .children(goalMode ? [] : part("away", this.awayGroup(t)))
        .children(goalMode ? [] : part("waiting", this.localGroup(t, "waiting", "WAITING ON YOU", v.local.filter((i) => i.kind === "blocked"))))
        .children(goalMode ? [] : part("desktop", this.desktopGroup(t, v.desktop, v.desktopDone)))
        .children(goalMode ? [] : part("landing", this.landingGroup(t)))
        .children(goalMode ? this.goalsGroup(t) : part("results", this.runReviewRows(t)))
        .children(goalMode ? [] : part("requested", this.prGroup(t, "requested", "REVIEW REQUESTS", v.requested, true, v.requestedDone)))
        .children(goalMode ? [] : part("mine", this.prGroup(t, "mine", "YOUR PRS", v.mine, false, v.mineDone, v.ready)))
        .children(goalMode ? [] : part("local", this.localGroup(t, "local", "UNCOMMITTED WORK", v.local.filter((i) => i.kind === "diff"), v.localDone)))
        .children(goalMode ? [] : part("linked", this.linkedReviewRows(t, v)))
        .children(goalMode ? [] : part("today", this.todayGroup(t, v.today)))
        .children(goalMode ? [] : part("trees", this.treeGroups(t, v.worktrees))));
  }
}


for (const views of [PrViews, TreeViews, KeyNav, LiveViews, LocalAddressed, AwayViews, DesktopViews, LandViews, GoalViews]) {
  for (const name of Object.getOwnPropertyNames(views.prototype)) {
    if (name !== "constructor") Inbox.prototype[name] = views.prototype[name];
  }
}
