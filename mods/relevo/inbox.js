import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, run, agents, panes, spaces, shared, setShared } from "herdr";
import { loadClaudeQuotas } from "./accounts.js";
import { accountFor, contextOfPath, inFocus } from "./context.js";
import { ago } from "./lib/time.js";
import { today, duration } from "./ledger.js";
import { openReview } from "./review.js";
import { button, sectionHeader, spinner, withKey } from "./ui.js";
import { seconds, recent } from "./lib/github.js";
import { COUNT, showPanel } from "./toolbar.js";
import { launched } from "./skills.js";
import { openWeek } from "./week.js";
import { PrViews } from "./inbox-prs.js";
import { TreeViews } from "./inbox-trees.js";
import { KeyNav, INBOX_FOCUS } from "./inbox-keys.js";

// Local work, pull requests and merged worktrees in one list; the PR and worktree parts live in their own files.
export class Inbox {
  init(_props, cx) {
    this.local = [];
    this.h = cx.focus_handle();
    this.sel = null;
    // An old request must not steal the keyboard when this copy starts.
    this.focusAt = shared(INBOX_FOCUS)?.at ?? null;
    this.mine = [];
    this.requested = [];
    this.prAgents = {};
    this.clones = {};
    this.expanded = {};
    this.quotas = {};
    this.prsAt = 0;
    this.worktrees = [];
    this.confirm = null;
    this.wtError = {};
    this.removing = new Set();
    this.gone = new Set();
    this.since = {};
    this.tops = new Map();
    this.stats = new Map();
    this.today = [];
    const panels = (shared("workspace.panels") ?? ["files", "changes"]).filter((p) => p !== "review");
    if (!panels.includes("inbox")) setShared("workspace.panels", [...panels, "inbox"]);
    this.live = this.liveSigns();
    this.scanLocal(cx);
    this.scanPRs(cx);
    this.loadQuotas(cx);
    this.scanTrees(cx);
    // Scans follow what changed; the slow timers only catch edits no agent or space reports.
    cx.timer.every(1500, (cx) => this.watchLive(cx));
    cx.timer.every(60000, (cx) => this.scanLocal(cx));
    cx.timer.every(180000, (cx) => this.scanPRs(cx));
    cx.timer.every(60000, (cx) => this.loadQuotas(cx));
    cx.timer.every(600000, (cx) => this.scanTrees(cx));
  }

  // In-memory only: no git and no redraw unless a scan finds something new.
  liveSigns() {
    const cwd = new Map(panes().map((p) => [p.pane, p.cwd]));
    return {
      agents: agents().map((a) => `${a.address}:${a.status}:${cwd.get(a.pane) ?? ""}`).join("|"),
      spaces: spaces().map((s) => s.folder).join("|"),
    };
  }

  watchLive(cx) {
    const now = this.liveSigns(), was = this.live;
    this.live = now;
    if (now.agents !== was.agents) this.scanLocal(cx);
    if (now.spaces !== was.spaces) this.scanTrees(cx);
  }

  todayGroup(t, list) {
    const total = list.reduce((n, d) => n + d.seconds, 0);
    return [
      h_flex().pt(6).px(2).gap(6).items_center().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child("AGENT TIME TODAY"))
        .when(total > 0, (el) => el.child(duration(total)))
        .child(button(t, "week-open", "Week", () => openWeek(), { size: "sm", tip: "Agent time per ticket and day" })),
      v_flex().children(list.map((d) => h_flex().id(`day-${d.key}`).h(24).px(8).gap(8).items_center().rounded(6)
        .child(div().flex_none().text_size(11.5).text_color(d.jira ? t.foreground : t.muted).child(d.key))
        .when(Boolean(d.jira), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(d.repo)))
        .when(!d.jira, (el) => el.child(div().flex_1()))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(duration(d.seconds))))),
    ];
  }

  loadQuotas(cx) {
    cx.spawn(async (cx) => {
      this.quotas = await loadClaudeQuotas();
      cx.notify();
    });
  }

  seen(pr) {
    const l = launched()[pr.url];
    return Boolean(l) && seconds(pr.updatedAt) <= l.at;
  }

  shown() {
    const pr = (p) => inFocus(accountFor(p.repo));
    return {
      local: this.local.filter((i) => inFocus(contextOfPath(i.top))),
      mine: this.mine.filter(pr), requested: this.requested.filter(pr),
      worktrees: this.worktrees.filter((w) => inFocus(contextOfPath(w.main))),
      today: this.today.filter((d) => inFocus(contextOfPath(d.repo))),
    };
  }

  publish(v = this.shown()) {
    const open = (list) => list.filter((p) => recent(p) && !this.seen(p)).length;
    const n = v.local.length + open(v.mine) + open(v.requested);
    if (shared(COUNT) !== n) setShared(COUNT, n);
  }

  scanLocal(cx) {
    if (this.scanning) {
      this.again = true;
      return;
    }
    this.scanning = true;
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        const byPane = new Map(panes().map((p) => [p.pane, p]));
        const byTab = new Map(Object.entries(launched()).map(([url, l]) => [l.tab, url]));
        const seen = new Set(), items = [], prAgents = {}, since = {};
        // Agents carry no timestamps, so a card's age is how long this status has been seen.
        for (const a of agents()) {
          since[`${a.address}:${a.status}`] = this.since[`${a.address}:${a.status}`] ?? Date.now() / 1000;
        }
        this.since = since;
        for (const a of agents()) {
          const url = byTab.get(a.tab_name);
          if (url) {
            prAgents[url] = a;
            continue;
          }
          if (a.address.includes("/") || a.status === "working") continue;
          const pane = byPane.get(a.pane);
          if (!pane?.cwd) continue;
          if (!this.tops.has(pane.cwd)) {
            this.tops.set(pane.cwd, (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pane.cwd })).stdout.trim());
          }
          const top = this.tops.get(pane.cwd);
          const repo = top.split("/").pop() || a.space_name;
          if (a.status === "blocked") {
            items.push({ kind: "blocked", agent: a, top, repo, branch: pane.branch });
            continue;
          }
          if (!top || seen.has(top)) continue;
          seen.add(top);
          // The diff of a resting agent only changes when its status does; re-read it at most once a minute otherwise.
          let cached = this.stats.get(top);
          if (!cached || cached.status !== a.status || Date.now() - cached.at > 60000) {
            const stat = (await exec("git", ["--no-optional-locks", "diff", "HEAD", "--shortstat"], { cwd: top })).stdout;
            const untracked = (await exec("git", ["--no-optional-locks", "ls-files", "--others", "--exclude-standard"], { cwd: top }))
              .stdout.split("\n").filter(Boolean).length;
            this.stats.set(top, cached = { status: a.status, at: Date.now(), stat, untracked });
          }
          const { stat, untracked } = cached;
          const files = Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0) + untracked;
          if (!files) continue;
          items.push({
            kind: "diff", agent: a, top, repo, branch: pane.branch, files,
            add: Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0), del: Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0),
          });
        }
        this.prAgents = prAgents;
        this.today = await today();
        for (const i of items) i.at = since[`${i.agent.address}:${i.agent.status}`];
        const local = items.sort((x, y) => (x.kind === "blocked" ? 0 : 1) - (y.kind === "blocked" ? 0 : 1) || y.at - x.at);
        // Redraw only when a card or today's time changed, not on every scan.
        const sign = JSON.stringify([
          local.map((i) => [i.agent.address, i.kind, i.files, i.add, i.del, Math.floor(i.at / 60)]),
          this.today,
        ]);
        this.local = local;
        if (sign !== this.sign) {
          this.sign = sign;
          this.publish();
          cx.notify();
        }
      } finally {
        this.scanning = false;
      }
      // A change seen mid-scan may have been read too early.
      if (this.again) this.scanLocal(cx);
    });
  }

  card(t, id, hot, head, meta, actions) {
    const sel = this.selected(id);
    return v_flex().id(id).p(10).gap(6).rounded(9).bg(sel ? t.selected : t.background).border_1()
      .border_color(sel ? t.accent : hot ? t.blocked : t.border)
      .child(head)
      .child(meta)
      .child(h_flex().gap(5).children(actions));
  }

  head(t, dot, title, when, ci = null, threads = 0) {
    const ring = dot === "ring";
    return h_flex().gap(7).items_center().min_w(0)
      .child(div().size(7).flex_none().rounded_full()
        .when(ring, (el) => el.border_1().border_color(t.dim))
        .when(!ring, (el) => el.bg(dot)))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).child(title))
      .when(threads > 0, (el) => el.child(this.threadBadge(t, threads, title)))
      .when(Boolean(ci), (el) => el.child(this.ciBadge(t, ci, title)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(when));
  }

  localCard(t, item) {
    const a = item.agent;
    const goAgent = () => run("agent.focus", { terminal: a.address });
    if (item.kind === "blocked") {
      return this.card(t, `in-${a.address}`, true,
        this.head(t, t.blocked, `${item.repo} · ${a.tab_name || item.branch || ""}`, ago(item.at)),
        div().text_size(11.5).text_color(t.muted).child("waiting for you"),
        [button(t, `go-${a.address}`, "Go to agent", goAgent, { kind: "solid" })]);
    }
    return this.card(t, `in-${a.address}`, false,
      this.head(t, a.status === "done" ? t.done : t.idle, `${item.repo}${item.branch ? ` · ${item.branch}` : ""}`, ago(item.at)),
      h_flex().gap(8).items_center().text_size(11.5).text_color(t.muted)
        .child(`${item.files} ${item.files === 1 ? "file" : "files"}`)
        .child(div().text_color(t.ansi2).child(`+${item.add}`))
        .child(div().text_color(t.ansi1).child(`−${item.del}`))
        .child(div().text_color(t.dim).child(a.status === "done" ? "agent finished" : "uncommitted")),
      [
        button(t, `review-${a.address}`, "Review", () => openReview(item.top, a.address), {
          kind: "solid", tip: withKey("Comment on the diff line by line", "relevo.review"),
        }),
        button(t, `diff-${a.address}`, "View diff", () => {
          run("pane.focus", { pane: a.pane });
          showPanel("changes");
        }),
        button(t, `files-${a.address}`, "Files", () => {
          run("pane.focus", { pane: a.pane });
          showPanel("files");
        }),
        button(t, `agent-${a.address}`, "Agent", goAgent),
      ]);
  }

  localGroup(t, label, items) {
    return items.length ? [sectionHeader(t, label, items.length), ...items.map((i) => this.localCard(t, i))] : [];
  }

  render(cx) {
    const t = theme(), v = this.shown();
    this.publish(v);
    this.takeFocus(cx);
    this.nav = this.navItems(v);
    this.keyboard = this.h.is_focused();
    if (this.sel && !this.nav.some((i) => i.id === this.sel)) this.sel = null;
    const total = v.local.length + v.mine.length + v.requested.length;
    return v_flex().id("relevo-inbox").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.surface ?? t.chrome).border_1().border_color(this.keyboard ? t.accent : t.border).text_color(t.foreground)
      .track_focus(this.h)
      .on_mouse_down("left", () => this.h.focus())
      .on_key_down((e, cx) => this.navKey(e, cx))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Inbox"))
        .child(this.prsAt
          ? div().text_size(11).text_color(t.dim).child(`PRs ${ago(this.prsAt)}`)
          : h_flex().gap(5).items_center().text_size(11).text_color(t.dim).child(spinner(t.dim, 10)).child("loading"))
        .child(div().flex_1())
        .child(div().id("inbox-refresh").px(6).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover)).tooltip("Refresh")
          .on_click((_e, cx) => {
            this.scanLocal(cx);
            this.scanPRs(cx);
            this.scanTrees(cx, true);
          })
          .child("↻")))
      .child(v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(6)
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_size(11.5).text_color(t.blocked).child(this.error)))
        .when(!total && !this.error && Boolean(this.prsAt), (el) => el.child(
          div().p(12).text_size(12).text_color(t.dim).child("Nothing waiting")))
        .children(this.localGroup(t, "WAITING ON YOU", v.local.filter((i) => i.kind === "blocked")))
        .children(this.localGroup(t, "UNCOMMITTED WORK", v.local.filter((i) => i.kind === "diff")))
        .children(this.prGroup(t, "mine", "YOUR PRS", v.mine, false))
        .children(this.prGroup(t, "requested", "REVIEW REQUESTS", v.requested, true))
        .children(this.todayGroup(t, v.today))
        .children(this.treeGroups(t, v.worktrees)));
  }
}


for (const views of [PrViews, TreeViews, KeyNav]) {
  for (const name of Object.getOwnPropertyNames(views.prototype)) {
    if (name !== "constructor") Inbox.prototype[name] = views.prototype[name];
  }
}
