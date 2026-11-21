// "While you were away": what finished, waits, changed on your PRs and was spent, shown once you're back.
// Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { agents, panes, exec, run, window } from "herdr";
import { ACCOUNTS } from "./accounts.js";
import { agentTimeBetween } from "./ledger.js";
import { button, joined, LANE, legHeader } from "./ui.js";
import { ago, duration } from "./lib/time.js";
import { lastMessage } from "./lib/prompt.js";
import { AWAY_AFTER, leftAt, awaySummary } from "./lib/away.js";

const LABELS = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.label]));

export class AwayViews {
  // On every live tick, from memory only; git, hc and the ledger are read once, on the way back.
  trackAway(list, cx) {
    const now = Date.now(), active = window()?.active !== false, working = list.filter((a) => a.status === "working");
    if (!this.away) {
      const since = leftAt({ active, now, lastTick: this.tickAt });
      if (since !== null) {
        this.away = { since, worked: new Set(this.workingBefore ?? []), events: [], quotas: JSON.parse(JSON.stringify(this.quotas ?? {})) };
      }
    }
    this.tickAt = now;
    this.workingBefore = working.map((a) => a.address);
    if (!this.away) return;
    for (const a of working) this.away.worked.add(a.address);
    if (!active) return;
    const away = this.away;
    this.away = null;
    if (now - away.since >= AWAY_AFTER) this.showAway(away, list, now, cx);
  }

  showAway(away, list, now, cx) {
    const summary = awaySummary({
      since: away.since, now, agents: list, worked: away.worked, events: away.events,
      quotasBefore: away.quotas, quotasNow: this.quotas, labels: LABELS,
    });
    if (!summary) return;
    cx.spawn(async (cx) => {
      const seconds = await agentTimeBetween(away.since / 1000, now / 1000).catch(() => 0);
      const said = {};
      for (const address of summary.finished.slice(0, 6)) {
        const r = await exec("hc", ["read", address, "--lines", "20"]);
        if (r.code === 0) said[address] = lastMessage(r.stdout);
      }
      this.digest = { ...summary, seconds, said };
      cx.notify();
    });
  }

  // Rows in screen order, shared by the card and the keyboard.
  awayItems() {
    if (this.snap?.away) return this.snap.away;
    const items = this.buildAway();
    if (this.snap) this.snap.away = items;
    return items;
  }

  buildAway() {
    const d = this.digest;
    if (!d) return [];
    const live = new Map(agents().map((a) => [a.address, a])), pane = new Map(panes().map((p) => [p.pane, p]));
    const name = (a) => {
      const p = pane.get(a.pane), repo = (p?.cwd ?? "").split("/").pop() || a.space_name || a.address;
      return `${repo}${p?.branch ? ` · ${p.branch}` : ""}`;
    };
    const focus = (a) => () => run("agent.focus", { terminal: a.address });
    const why = this.waitingReasons();
    return [
      ...d.finished.filter((x) => live.has(x)).map((x) => ({
        id: `away-done-${x}`, kind: "done", label: name(live.get(x)), note: d.said[x], go: focus(live.get(x)),
      })),
      ...d.waiting.filter((x) => live.get(x)?.status === "blocked").map((x) => ({
        id: `away-wait-${x}`, kind: "blocked", label: name(live.get(x)), note: why[x] ?? "waiting for you", go: focus(live.get(x)),
      })),
      ...d.prs.map((p, i) => ({
        id: `away-pr-${i}`, kind: "pr", label: p.title, at: p.at, go: () => /^https:\/\//.test(p.url) && exec("open", [p.url]),
      })),
    ];
  }

  // Each item's one action, for its button and its key alike.
  awayAction(r) {
    return { id: `${r.id}-open`, key: "o", label: r.kind === "pr" ? "Open" : "Agent", run: () => r.go(), kind: r.kind === "blocked" ? "go" : undefined };
  }

  awayGroup(t) {
    const d = this.digest;
    if (!d) return [];
    const turn = { done: "ready", blocked: "me", pr: "open" };
    const spent = d.quota.map((q) => `${q.label} ${[q.h5 && `5h +${q.h5}%`, q.d7 && `7d +${q.d7}%`].filter(Boolean).join(" ")}`);
    const facts = [...spent, d.seconds >= 60 && `${duration(d.seconds)} of agent time`].filter(Boolean).join(" · ");
    return [
      legHeader(t, "away", "While you were away", duration(Math.round((d.now - d.since) / 1000)), {
        after: [button(t, "away-dismiss", "Dismiss", (cx) => {
          this.digest = null;
          cx.notify();
        }, { size: "sm", kind: "ghost" })],
      }),
      facts ? div().id("away-facts").pl(LANE).pr(8).pb(2).text_size(11).text_color(t.muted).child(facts) : null,
      ...joined(t, this.awayItems().map((r) => this.item(t, r.id, {
        turn: turn[r.kind], kind: r.kind === "pr" ? "pr" : "agent", title: r.label, reason: r.note ?? null, age: r.at ? ago(r.at, true) : null, tip: r.note ?? null, main: this.awayAction(r),
      }))),
    ].filter(Boolean);
  }
}
