import { terminals, playSound, notify, shared, setShared } from "herdr";
import { ACCOUNTS, accountOf } from "./accounts.js";
import { contextOfPath, inFocus } from "./context.js";
import { CONTEXTS } from "./config.js";

const ALERTED = "relevo.alerted";
const KNOWN = "relevo.reviews.known";

// A background task (⧗) that finished: the hook clears agent.wait on the next Stop.
export class BackgroundWatch {
  constructor() {
    this.waiting = new Map();
  }

  tick() {
    const now = new Map(terminals().filter((k) => k.state === "live").map((k) => [k.address, k]));
    for (const [address, before] of this.waiting) {
      const k = now.get(address);
      if (!k || k.labels?.["agent.wait"] === "watch" || !inFocus(contextOfPath(k.cwd))) continue;
      playSound("sounds/bg-done.mp3");
      notify({
        title: "Background work finished",
        body: `${before.where ?? address}: ${before.labels?.["agent.bg"] ?? ""}`.trim(),
        level: "success",
        action: { name: "agent.focus", args: { terminal: address } },
      });
    }
    this.waiting = new Map([...now].filter(([, k]) => k.labels?.["agent.wait"] === "watch"));
  }
}

// One soft alert per account window at 80% and another at 100%, again only after it resets.
// At 100% a Claude account's alert offers to continue its agent with another account.
export function quotaAlerts(quotas) {
  const first = shared(ALERTED) == null, seen = { ...(shared(ALERTED) ?? {}) };
  let changed = first;
  for (const [key, q] of Object.entries(quotas)) {
    for (const [name, w] of [["5h", q?.h5], ["7d", q?.d7]]) {
      const full = w?.pct >= 100, id = `${key}.${name}${full ? ".full" : ""}`;
      // Some sources compute the reset from "now + remaining", so it drifts by seconds.
      const resets = Math.round((w?.resets ?? 0) / 3600);
      if (!w || w.pct < 80 || seen[id] === resets) continue;
      seen[id] = resets;
      changed = true;
      const context = CONTEXTS.find((c) => c.account === key);
      if (first || (context && !inFocus(context.key))) continue;
      playSound("sounds/quota.mp3");
      const handoff = full && ACCOUNTS.some((p) => p.key === key);
      notify({
        title: `${accountOf(key).label} at ${w.pct}% (${name})`,
        level: "warning",
        ...(handoff ? { body: "Click to continue its agent with another account", action: { name: `relevo.handoff-from-${key}` } } : {}),
      });
    }
  }
  if (changed) setShared(ALERTED, seen);
}

// New review requests since the last look.
export function reviewAlerts(requested, contextOf) {
  const stored = shared(KNOWN), known = new Set(stored ?? []);
  const fresh = requested.filter((p) => !known.has(p.url));
  if (fresh.length && stored != null) {
    const shown = fresh.filter((p) => inFocus(contextOf(p.repo)));
    if (shown.length) {
      playSound("sounds/review.mp3");
      notify({
        title: shown.length === 1 ? "Review requested" : `${shown.length} reviews requested`,
        body: shown.map((p) => `${p.repo.split("/")[1]} #${p.number} · ${p.title}`).join("\n"),
        level: "info",
        action: { name: "layout.show", args: { id: "panel" } },
      });
    }
  }
  if (fresh.length || stored == null) setShared(KNOWN, requested.map((p) => p.url));
}

// Changes on your PRs; the click opens the Inbox.
const LOUD = new Set(["ci-failed", "threads", "changes"]);
const LEVEL = { "ci-failed": "warning", changes: "warning", threads: "info", "ci-passed": "success", approved: "success" };

export function prAlerts(events, contextOf) {
  const shown = events.filter((e) => inFocus(contextOf(e.repo)));
  if (shown.some((e) => LOUD.has(e.kind))) playSound("sounds/review.mp3");
  for (const e of shown) notify({ title: e.title, level: LEVEL[e.kind], action: { name: "relevo.panel-inbox" } });
}
