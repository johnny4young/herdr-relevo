import { GoalViews, GOAL_MODE } from "./inbox-goals.js";
import { div } from "gpui-kit";
import { PreviewInbox } from "./decision-preview.js";
import { SnapshotInbox } from "./snapshot-preview.js";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec, run, agents, panes, terminals, shared, setShared, machines, setBadge } from "herdr";
import { loadClaudeQuotas } from "./accounts.js";
import { accountFor, contextOfPath, inFocus } from "./context.js";
import { ago, nextSince } from "./lib/time.js";
import { today, duration } from "./ledger.js";
import { openReview, REVIEW_SHORTCUT_ACTIONS } from "./review.js";
import { askSecondOpinion, secondOpinionNotice } from "./second-opinion.js";
import { openHandoff } from "./handoff.js";
import { openReplies } from "./replies.js";
import { button, spinner, withKey, foldRow, FOLDS, shortcutBindings, icon, keycap, row, diffRatio, tabButton, keyBar, actionButton, paced } from "./ui.js";
import { ShortcutHelp } from "./shortcut-help.js";
import { INBOX_SHORTCUT_ACTIONS, barKeys } from "./lib/shortcut-help.js";
import { AGENT_PRS, agentPRs, seconds } from "./lib/github.js";
import { isAddressed } from "./lib/addressed.js";
import { capMap } from "./lib/cache.js";
import { GIT_READ, githubRepo, withoutLogin } from "./lib/git.js";
import { STATS_FOR } from "./lib/refresh.js";
import { freeOption, lastMessage, reasonOf } from "./lib/prompt.js";
import { COUNT, RUNS_COUNT, RUNS_FLIGHT, showPanel } from "./toolbar.js";
import { launched } from "./skills.js";
import { taskTurn } from "./lib/run-panel.js";
import { openWeek } from "./week.js";
import { ActionViews } from "./inbox-actions.js";
import { PromptViews } from "./inbox-prompts.js";
import { PrViews } from "./inbox-prs.js";
import { TreeViews } from "./inbox-trees.js";
import { BranchViews } from "./inbox-branches.js";
import { KeyNav, INBOX_FOCUS } from "./inbox-keys.js";
import { LiveViews } from "./inbox-live.js";
import { LocalAddressed } from "./inbox-addressed.js";
import { AwayViews } from "./inbox-away.js";
import { DesktopViews } from "./inbox-desktop.js";
import { LandViews, LANDING } from "./inbox-land.js";
import { NowViews, NOW_SECTIONS, MAINTENANCE_SECTIONS } from "./inbox-now.js";
import { RunViews } from "./inbox-runs.js";
import { RunCompareViews } from "./inbox-run-compare.js";
import { CliViews } from "./inbox-clis.js";
import { isSettled } from "./lib/desktop.js";
import { machineLook, machineOf } from "./lib/machines.js";

const LOCAL_STUCK = 60000;
const HEAD_FOR = 15000;
const hc = (args) => exec("hc", args);
// Why each waiting agent waits: address -> a short line, for the agents list.
const REASONS = "relevo.reasons";
// Open PRs in Now by repo name, and how many need you, for the Spaces list.
export const REPO_PRS = "relevo.repoPRs";
// The ? sheet: the Inbox's keys, then the review pane's.
const SHEET = [...INBOX_SHORTCUT_ACTIONS, ...REVIEW_SHORTCUT_ACTIONS];

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
      actions: SHEET,
      onClose: (cx) => { this.goalHelp = false; this.h.focus(); cx.notify(); },
    }, cx);
    this.sel = null;
    // An old request must not steal the keyboard when this copy starts.
    this.focusAt = shared(INBOX_FOCUS)?.at ?? null;
    this.mine = [];
    this.ready = [];
    this.requested = [];
    this.answered = [];
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
    this.filterField = InputState.new({ value: "", placeholder: "Filter · Esc clears" });
    this.filterField.on("change", (_e, cx) => cx.notify());
    this.filterField.on("submit", (_e, cx) => this.leaveFilter(cx));
    this.actionQuery = InputState.new({ value: "", placeholder: "Filter actions…" });
    this.actionQuery.on("change", (_e, cx) => { this.actionAt = 0; cx.notify(); });
    this.actionQuery.on("submit", (_e, cx) => this.runActionMenu(cx));
    this.snoozed = {};
    this.actionMenu = null;
    this.today = [];
    this.digest = null;
    const panels = (shared("workspace.panels") ?? ["files", "changes"]).filter((p) => p !== "review");
    if (!panels.includes("inbox")) setShared("workspace.panels", [...panels, "inbox"]);
    this.labelling = {};
    this.terms = new Map();
    this.startGoals(cx);
    this.startRuns();
    this.startLive(cx);
    this.scanLocal(cx);
    this.loadAddressed(cx);
    this.loadSnoozed(cx);
    this.scanPRs(cx);
    this.loadQuotas(cx);
    this.scanTrees(cx);
    this.startLand(cx);
    // These feed alerts, so they keep running behind other apps.
    this.scanClis(cx);
    cx.timer.every(180000, paced((cx) => this.scanPRs(cx), 2));
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
      mine: this.mine.filter(open), requested: this.requested.filter(open), answered: this.answered.filter(pr),
      ready: this.ready.filter(open),
      mineDone: [...this.mine, ...this.ready].filter(done), requestedDone: this.requested.filter(done),
      worktrees: this.worktrees.filter((w) => inFocus(contextOfPath(w.main))),
      today: this.today.filter((d) => inFocus(contextOfPath(d.repo))),
    };
  }

  publish(v = this.shown(), entries = this.nowEntries(theme(), v)) {
    // The badge is the Needs me count, so it always matches the legend.
    const n = entries.filter((e) => e.turn === "me").length;
    if (shared(COUNT) !== n) setShared(COUNT, n);
    // The Dock icon says it too, Herdr in front or not; set only when it changes.
    if (this.badge !== n) {
      this.badge = n;
      setBadge(n ? String(n) : null);
    }
    this.publishReasons();
    this.publishAgentPRs();
    this.publishRepoPRs(entries);
    this.publishSettled();
    this.publishRunsCount();
  }

  publishRunsCount() {
    const tasks = this.workflowTasks ?? [];
    const need = tasks.filter((x) => !x.pr && ["me", "stuck"].includes(taskTurn(x))).length;
    const flight = tasks.filter((x) => taskTurn(x) === "flight").length;
    if ((shared(RUNS_COUNT) ?? 0) !== need) setShared(RUNS_COUNT, need);
    if ((shared(RUNS_FLIGHT) ?? 0) !== flight) setShared(RUNS_FLIGHT, flight);
  }

  publishRepoPRs(entries) {
    const now = {};
    for (const e of entries.filter((x) => x.repo)) {
      const name = e.repo.split("/").pop().toLowerCase(), c = now[name] ??= { open: 0, me: 0 };
      c.open += 1;
      if (e.turn === "me") c.me += 1;
    }
    if (JSON.stringify(shared(REPO_PRS) ?? {}) !== JSON.stringify(now)) setShared(REPO_PRS, now);
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
            // A folder that is gone (a removed worktree) rejects: that agent goes without a repo, the scan goes on.
            const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pane.cwd }).catch(() => null);
            if (r) this.tops.set(pane.cwd, r.stdout.trim());
          }
          const top = this.tops.get(pane.cwd) ?? "";
          // A worktree's folder isn't named after its repo, so origin says which it is.
          if (top && !this.origins.has(top)) {
            const origin = await exec("git", ["-C", top, "remote", "get-url", "origin"]).catch(() => null);
            if (!origin) { this.tops.delete(pane.cwd); continue; }
            this.origins.set(top, githubRepo(withoutLogin(origin.stdout)));
          }
          const head = top ? await this.headOf(top) : "";
          places.push({ address: a.address, repo: this.origins.get(top), branch: pane.branch, head });
        }
        this.places = places;
        // Another machine's agent can still ask: its question is read over Herdr; its diff would need that machine's git.
        const known = machines();
        for (const a of [...all].sort((x, y) => marked(x) - marked(y))) {
          const url = byTab.get(a.tab_name);
          if (url) {
            prAgents[url] = a;
            if (a.status !== "blocked") continue;
          }
          const machine = machineOf(a.address), look = machine ? machineLook(machine, known) : null;
          if (a.status === "working" || (machine && (a.status !== "blocked" || look.away))) continue;
          const pane = byPane.get(a.pane);
          if (!pane?.cwd && !machine) continue;
          const top = machine ? "" : this.tops.get(pane.cwd) ?? "";
          const repo = top.split("/").pop() || a.space_name;
          if (a.status === "blocked") {
            const at = since[`${a.address}:blocked`];
            if (this.prompts.get(a.address)?.since !== at) {
              // A machine that drops mid-scan costs its card, not the whole scan.
              const read = await hc(["read", a.address, "--lines", "0"]).catch((e) => { if (machine) return null; throw e; });
              if (!read) continue;
              const screen = read.stdout;
              const prompt = await this.promptOf(a.address, screen);
              this.prompts.set(a.address, { since: at, prompt, free: freeOption(prompt) });
            }
            items.push({ kind: "blocked", agent: a, top, repo, branch: pane?.branch, machine: look, prompt: this.prompts.get(a.address).prompt });
            continue;
          }
          if (!top || seen.has(top)) continue;
          seen.add(top);
          // The diff of a resting agent only changes when its status does; re-read it at most once a minute otherwise.
          let cached = this.stats.get(top);
          if (!cached || this.dirty.delete(top) || cached.status !== a.status || Date.now() - cached.at > STATS_FOR) {
            try {
              const stat = (await exec("git", [...GIT_READ, "diff", "HEAD", "--shortstat"], { cwd: top })).stdout;
              const untracked = (await exec("git", [...GIT_READ, "ls-files", "--others", "--exclude-standard"], { cwd: top }))
                .stdout.split("\n").filter(Boolean).length;
              // What the agent said last, so the card tells whether to review or to answer it.
              const said = lastMessage((await hc(["read", a.address, "--lines", "20"])).stdout);
              this.stats.set(top, cached = { status: a.status, at: Date.now(), stat, untracked, said });
            } catch {
              // Its checkout went away since it was found: forget it and leave that card out.
              this.tops.delete(pane.cwd); this.stats.delete(top);
              continue;
            }
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
          local.map((i) => [i.agent.address, i.kind, i.machine?.color, i.files, i.add, i.del, i.said, Math.floor(i.at / 60), this.addressedLabel(i.agent.address)]),
          this.today,
        ]);
        this.local = local;
        // A reply whose question went away (answered in the terminal) would keep holding the keyboard.
        if (this.replying && !local.some((i) => i.kind === "blocked" && i.agent.address === this.replying)) { this.replying = null; this.replyKey = null; }
        this.publishReasons();
        this.publishAgentPRs();
        await this.watchRepos(seen, cx);
        capMap(this.tops, 200);
        capMap(this.origins, 200);
        capMap(this.stats, 200);
        capMap(this.heads, 200);
        if (sign !== this.sign) {
          this.sign = sign;
          this.publish();
          cx.notify();
        }
        if (this.localError) {
          this.localError = null;
          cx.notify();
        }
        this.localOkAt = Date.now() / 1000;
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
    const r = await exec("git", [...GIT_READ, "-C", top, "rev-parse", "HEAD"]).catch(() => null);
    if (!r || r.code !== 0) {
      this.heads.delete(top);
      return "";
    }
    const head = r.stdout.trim();
    this.heads.set(top, { head, at: Date.now() });
    return head;
  }

  // An item as one row: its one action at the edge. Selected, it opens in place with its lines and every
  // other action; in flight rows offer nothing until then.
  // `open` keeps its lines in sight unselected; its other actions still wait for the selection.
  // `done` (marked addressed) waits on nobody, whatever its turn would be.
  // `main`, `actions` and `mark` are the row's action table (see actionButton); selected, keyed ones show their key.
  // `status` takes the age's place and stays at any width. At the narrowest, a me row's action is a chevron.
  item(t, id, { turn, kind, title, reason = null, age = null, status = null, tip = null, lines = [], main = null, actions = [], mark = null, open = false, done = false, machine = null }) {
    if (this.hiddenIds?.has(id)) return null;
    const sel = this.selected(id), tight = Boolean(this.tightInbox), words = typeof main?.label === "string" ? main.label : null;
    const edge = tight && !done && turn === "me" && main && !main.el
      ? { ...main, label: [icon("chevron-right")], tip: main.tip ?? words, accessibleLabel: main.accessibleLabel ?? words ?? main.tip } : main;
    const draw = (a) => {
      const b = actionButton(t, a);
      return sel && a.key ? h_flex().gap(4).items_center().flex_none().child(keycap(t, a.key)).child(b) : b;
    };
    const rest = sel ? [...actions.filter((a) => a && a !== main), mark].filter(Boolean).map(draw) : [];
    const below = sel || open ? [...(typeof lines === "function" ? lines() : lines).filter(Boolean), ...(rest.length ? [h_flex().flex_wrap().gap(5).pt(2).children(rest)] : [])] : [];
    return row(t, id, {
      turn: done ? "open" : turn, kind, title, reason, age: status ?? (tight ? null : age), tip, selected: sel, narrow: tight,
      action: (turn === "flight" && !sel) || !main ? null : draw(edge),
      onSelect: (cx) => this.pick(id, cx), machine,
      below: below.length ? below : null,
    });
  }

  // A click opens a row, or closes the one already open; the keyboard follows.
  pick(id, cx) {
    this.sel = this.sel === id ? null : id;
    this.clicked = true;
    this.filtering = false;
    this.h.focus();
    cx.notify();
  }



  close() {
    if (this.preview) return this.preview.close();
    this.stopWatches?.();
    this.h?.release();
    this.reply.release();
    this.filterField?.release();
    this.actionQuery?.release();
    this.runChange?.release();
    this.fixNote?.release();
    this.shortcutHelp?.close();
  }

  // What a local row can do, for its buttons, its keys and its keycaps alike.
  // The card may be a minute behind the checkout: read it again now.
  reviewLocal(item, cx) {
    openReview(item.top, item.agent.address);
    this.dirty.add(item.top);
    if (cx) this.scanLocal(cx);
  }

  localActions(item, addressed = false) {
    const a = item.agent, goAgent = { id: `agent-${a.address}`, key: "o", label: "Agent", run: () => run("agent.focus", { terminal: a.address }) };
    if (item.kind === "blocked") {
      const p = item.prompt ?? { question: "", options: [] };
      if (this.replying === a.address) return { main: null, actions: [] };
      const submit = p.submit ? { id: `submit-${a.address}`, label: "Submit", run: (cx) => this.submit(a, p, cx), kind: "go" } : null;
      const reply = p.options.length || p.unparsed ? null : { id: `reply-${a.address}`, label: "Reply", run: (cx) => this.startReply(a, null, cx), kind: "go" };
      return {
        main: submit ?? reply,
        actions: [
          { ...goAgent, id: `go-${a.address}`, label: p.options.length ? "Agent" : "Go to agent" },
          p.options.length ? { id: `note-${a.address}`, label: "Note", run: (cx) => this.startReply(a, null, cx, "note"), tip: "Sent to the agent right after your answer" } : null,
          { id: `handoff-${a.address}`, label: "Continue with…", run: () => openHandoff(a.address) },
        ],
      };
    }
    const main = { id: `review-${a.address}`, key: "r", label: "Review", run: (cx) => this.reviewLocal(item, cx), kind: "go", tip: withKey("Comment on the diff line by line", "relevo.review") };
    const all = [
      main,
      goAgent,
      this.opinionAction(item),
      this.sourceContextAction(`local:${item.top || a.address}`),
      { id: `diff-${a.address}`, label: "View diff", run: () => {
        run("pane.focus", { pane: a.pane });
        showPanel("changes");
      } },
      { id: `files-${a.address}`, label: "Files", run: () => {
        run("pane.focus", { pane: a.pane });
        showPanel("files");
      } },
      { id: `reply-${a.address}`, label: "Reply", run: () => openReplies(a.address), tip: withKey("Send it a message or a quick reply", "relevo.quick-reply") },
    ];
    const direct = [main, goAgent];
    const overflow = all.filter((a) => a && !direct.includes(a));
    const mark = this.markAction(a.address, addressed, (on, cx) => this.setLocalAddressed(a, on, cx), "Addressed: hide until its agent works again");
    const entry = {
      id: `in-${a.address}`,
      title: item.repo,
      snooze: !addressed ? { id: `in-${a.address}`, updatedAt: item.at ?? 0, label: item.repo } : null,
      allActions: () => [...all, mark].filter(Boolean),
      moreActions: () => overflow,
    };
    const snooze = !addressed && this.openActionMenu ? {
      id: `snooze-in-${a.address}`, key: "h", label: [icon("clock")], tip: "Snooze · h", accessibleLabel: "Snooze local changes",
      run: (cx) => this.openActionMenu(entry, cx, { mode: "snooze" }),
    } : null;
    const more = overflow.length && this.openActionMenu ? {
      id: `more-in-${a.address}`, label: [icon("more")], tip: "More actions · ⌘K", accessibleLabel: "More actions",
      run: (cx) => this.openActionMenu(entry, cx, { mode: "more" }),
    } : null;
    return {
      main,
      actions: [...direct, snooze, more].filter(Boolean),
      allActions: all,
      overflow,
      mark,
    };
  }

  // Another model reviews this uncommitted work; the verdict comes back in Runs.
  opinionAction(item) {
    const a = item.agent, asking = this.opinionFor === a.address;
    return { id: `opinion-${a.address}`, label: asking ? "Asking…" : "Second opinion", tip: "Another model runs the tests and reviews this uncommitted work; its verdict comes back in Runs",
      run: (cx) => {
        if (this.opinionFor) return;
        const cwd = panes().find((p) => p.pane === a.pane)?.cwd ?? a.cwd ?? item.top;
        this.opinionFor = a.address; cx.notify();
        cx.spawn(async (cx) => {
          try { await askSecondOpinion(a, cwd, cx); } catch (error) { secondOpinionNotice(error); }
          this.opinionFor = null; cx.notify();
        });
      } };
  }

  localCard(t, item, addressed = false) {
    const a = item.agent;
    if (item.kind === "blocked") return this.waitingCard(t, item);
    const files = `${item.files} ${item.files === 1 ? "file" : "files"}`, state = a.status === "done" ? "agent finished" : "uncommitted";
    return this.item(t, `in-${a.address}`, {
      turn: "me", done: addressed, kind: "agent", title: item.repo, reason: `${files} · ${state}`, tip: item.branch || null, age: ago(item.at, true),
      lines: [
        h_flex().gap(8).items_center().text_size(11).text_color(t.muted)
          .when(Boolean(item.branch), (el) => el.child(div().min_w(0).truncate().child(item.branch)))
          .child(div().text_color(t.ansi2).child(`+${item.add}`))
          .child(div().text_color(t.ansi1).child(`−${item.del}`))
          .child(diffRatio(t, item.add, item.del)),
        item.said ? div().id(`said-${a.address}`).truncate().text_size(11).text_color(t.dim).italic().tooltip(item.said).child(`“${item.said}”`) : null,
      ],
      ...this.localActions(item, addressed),
    });
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
    const t = theme(), v = this.shown(), entries = this.nowEntries(t, v);
    // Avoid full publish() serialization on pure j/k selection moves when queue data hasn't changed.
    const pubSign = `${entries.map((e) => `${e.id}:${e.turn}`).join("|")}#${(this.workflowTasks ?? []).map((x) => `${x.id}:${x.state}:${Boolean(x.pr)}`).join(",")}#${this.local.length}`;
    if (pubSign !== this.lastDrawPubSign) {
      this.lastDrawPubSign = pubSign;
      this.publish(v, entries);
    }
    this.takeFocus(cx);
    this.refreshGoals(cx);
    const goalMode = shared(GOAL_MODE) === true;
    this.goalProjection = this.projectGoals(v);
    const runs = goalMode ? this.syncRun(cx) : [];
    if (goalMode) this.followUpTaken(cx);
    const reviewView = goalMode ? null : this.reviewView(), runOpen = goalMode && Boolean(this.goalProjection.scope);
    const [runLeft, runRight] = goalMode ? this.runsHeader(t) : [[], []];
    const counts = this.nowCounts(entries);
    // In Now, cache the Maintenance count briefly so j/k navigation doesn't rebuild tidyTerminals() every frame.
    const upkeepKey = `${v.worktrees.length}:${v.mine.length}:${v.requested.length}:${this.staleShown?.().length ?? 0}:${terminals().length}`;
    const upkeep = goalMode ? null
      : reviewView === "now" && this.upkeepCache?.key === upkeepKey && Date.now() - this.upkeepCache.at < 3000
        ? this.upkeepCache.value
        : (this.upkeepCache = { key: upkeepKey, at: Date.now(), value: this.maintenanceModel(v) }).value;
    const shownNow = this.filterNow(entries), errors = reviewView === "now" ? this.readErrors() : [];
    const firstRead = !goalMode && !this.prsAt && Boolean(this.scanningPRs);
    // Nothing needs you only once PRs were read and every source answered.
    this.calm = reviewView === "now" && Boolean(this.prsAt) && Boolean(this.localOkAt) && !errors.length && !counts.me && !counts.ready ? { flight: counts.flight, upkeep: upkeep.count } : null;
    // A row you snoozed, marked or landed hands the selection to its neighbour in the same list; one a refresh
    // took away clears it, so Enter never acts on a row you did not pick.
    const prevNav = this.navView === (goalMode ? "runs" : reviewView) ? this.nav ?? [] : [];
    this.navView = goalMode ? "runs" : reviewView;
    this.nav = goalMode ? this.runNav(runs) : reviewView === "now" ? this.nowNav(shownNow) : this.maintenanceNav(v, upkeep);
    this.keyboard = this.h.is_focused();
    if (this.sel && !this.nav.some((i) => i.id === this.sel)) {
      const was = this.sel === this.advanceFrom ? prevNav.findIndex((i) => i.id === this.sel) : -1;
      this.sel = was >= 0 && this.nav.length ? this.nav[Math.min(was, this.nav.length - 1)].id : null;
    }
    if (this.advanceFrom !== this.sel) this.advanceFrom = null;
    const view = goalMode ? this.goalViewport() : this.viewport(reviewView === "now" ? NOW_SECTIONS : MAINTENANCE_SECTIONS);
    this.hiddenIds = view.hidden;
    const part = (key, els) => (view.sections.has(key) ? [] : els.filter(Boolean));
    const bulk = reviewView === "maintenance" ? this.bulkBar(t, v.worktrees) : null;
    return v_flex().id("relevo-inbox").size_full().min_w(0).min_h(0).rounded(10).overflow_hidden()
      .on_size_change((size, context) => {
        const narrow = size.width < 350, tight = size.width <= 300;
        if (this.narrowInbox !== narrow || this.tightInbox !== tight) {
          this.narrowInbox = narrow;
          this.tightInbox = tight;
          context.notify();
        }
      })
      .bg(t.surface ?? t.chrome).border_1().border_color(this.keyboard ? t.accent : t.border).text_color(t.foreground)
      .track_focus(this.h)
      .tab_index(0).role("group").accessibility_label(`${goalMode ? "Runs" : "Reviews"}. Arrow keys select work; Enter opens its primary action. Tab moves through controls.`)
      .on_key_down((e, cx) => this.navKey(e, cx))
      .when(goalMode, (el) => el.on_mouse_down("back", (_e, cx) => this.runBack(cx)).on_mouse_down("forward", (_e, cx) => this.runAhead(cx)))
      .child(h_flex().h(38).flex_none().px(8).gap(6).items_center()
        .when(goalMode, (el) => el.children([...runLeft, ...runRight]))
        .when(!goalMode, (el) => el
          .child(this.viewTab(t, "now", "Now", firstRead ? "…" : counts.me + counts.flight + counts.ready, "What needs you, what is in flight and what is ready"))
          .child(this.viewTab(t, "maintenance", "Maintenance", firstRead ? "…" : upkeep.count, "What can wait: old PRs, worktrees, what you marked addressed"))
          .child(div().flex_1()))
        .child(button(t, "goal-key-help", "?", (cx) => {
          this.goalHelp = !this.goalHelp;
          if (this.goalHelp) this.shortcutHelp.focus();
          else this.h.focus();
          cx.notify();
        }, { size: "sm", tip: "Search keyboard shortcuts", accessibleLabel: "Keyboard help" }))
        .when(!runOpen, (el) => el.child(button(t, "inbox-refresh", goalMode && !this.prsAt && this.scanningPRs ? [spinner(t.dim, 10)] : [icon("refresh")], (cx) => {
          this.scanLocal(cx); this.scanPRs(cx); this.scanTrees(cx, true); this.loadGoals(cx); this.scanClis(cx);
        }, { size: "sm", accessibleLabel: "Refresh work", tip: `Refresh · ${this.prsAt ? `PRs ${ago(this.prsAt)}` : this.scanningPRs ? "PRs loading" : "PRs unavailable"}${this.error ? ` · ${this.error}` : ""}` }))))
      .when(firstRead, (el) => el.child(this.firstReadLine(t)))
      .when(reviewView === "now" && (this.filtering || Boolean(this.filterField.value())), (el) => el.child(h_flex().id("inbox-filter").h(30).flex_none().mx(8).mt(4).px(8).gap(6)
        .items_center().rounded(6).border_1().border_color(this.filtering ? t.accent : t.border).bg(t.background)
        .child(icon("search", t.dim)).child(div().flex_1().min_w(0).child(Input.new(this.filterField).h_full()))))
      .when(Boolean(this.actionMenu), (el) => el.child(this.renderActionMenu(t)))
      .when(this.goalHelp, (el) => {
        this.shortcutHelp.setData(SHEET, shortcutBindings());
        return el.child(this.shortcutHelp.render(t, cx));
      })
      .when(reviewView === "now", (el) => el.child(h_flex().flex_none().pr(12).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).child(this.nowLegend(t, counts)))
        .when(Boolean(this.prsAt) && !this.tightInbox, (row) => row.child(div().id("read-age").flex_none().text_size(11).text_color(t.dim).child(`read ${ago(this.prsAt)}`)))))
      .when(goalMode && !runOpen, (el) => el.child(div().flex_none().border_b(1).border_color(t.border).child(this.runsLegend(t, runs))))
      .when(reviewView === "maintenance", (el) => el.child(h_flex().flex_none().border_b(1).border_color(t.border).child(this.maintenanceLegend(t, upkeep))))
      .child(v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).py(6).gap(2)
        .when(reviewView !== "now" && Boolean(this.error), (el) => el.child(div().p(8).text_size(11).text_color(t.blocked).child(this.error)))
        .when(reviewView !== "now" && Boolean(this.localError), (el) => el.child(div().id("local-error").p(8).text_size(11).text_color(t.blocked).child(this.localError)))
        .when(reviewView === "maintenance" && Boolean(this.workflowError), (el) => el.child(div().id("workflow-error").p(8).text_size(11).text_color(t.blocked).child(this.workflowError)))
        .when(view.above > 0, (el) => el.child(div().px(4).text_size(11).text_color(t.dim).child(`↑ ${view.above} above · Esc`)))
        .children(goalMode ? this.runsBody(t, runs) : [])
        .children(reviewView === "now" ? [...part("errors", this.errorGroup(t, errors)), ...part("clis", this.cliGroup(t)), ...part("away", this.awayGroup(t)), ...this.nowGroups(t, shownNow, part),
          ...(firstRead ? this.prSkeleton(t) : [])] : [])
        .children(reviewView === "maintenance" ? this.maintenanceGroups(t, v, part, upkeep) : []))
      .when(Boolean(bulk), (el) => el.child(bulk))
      .when(!bulk, (el) => el.child(goalMode ? this.runsKeys(t) : this.listKeys(t, reviewView)));
  }

  // The first PR read, under the header: what is read already and what is still asked.
  firstReadLine(t) {
    return h_flex().id("first-read").h(28).flex_none().pl(16).pr(8).gap(14).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
      .when(Boolean(this.localOkAt && this.workflowAt), (el) => el.child(h_flex().gap(6).items_center().child(icon("check", t.done, 11)).child(div().child("agents and runs read"))))
      .child(h_flex().gap(6).items_center().min_w(0).child(spinner(t.working, 11)).child(div().truncate().child("asking GitHub…")));
  }

  // The keys that work in the list on screen, at its foot, as the ? sheet tags them; a bulk bar takes its place while rows are marked.
  listKeys(t, view) {
    return keyBar(t, "list-keys", barKeys(INBOX_SHORTCUT_ACTIONS, view), [["?"], "keys"]);
  }

  // A view of Reviews as an underlined tab with its count.
  viewTab(t, view, label, n, tip) {
    const on = this.reviewView() === view;
    return tabButton(t, `view-${view}`, [div().child(label), div().text_size(11).text_color(t.muted).child(String(n))],
      on, (cx) => this.setReviewView(view, cx), tip).h(30).px(8).gap(6).when(on, (el) => el.font_semibold());
  }
}


for (const views of [ActionViews, PromptViews, PrViews, TreeViews, BranchViews, KeyNav, LiveViews, LocalAddressed, AwayViews, DesktopViews, LandViews, GoalViews, NowViews, RunViews, RunCompareViews, CliViews]) {
  for (const name of Object.getOwnPropertyNames(views.prototype)) {
    if (name !== "constructor") Inbox.prototype[name] = views.prototype[name];
  }
}
