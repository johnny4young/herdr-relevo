import { agents, exec, panes, terminals, playSound, notify as toast, shared, setShared, window } from "herdr";
import { ACCOUNTS, CODEX, accountOf } from "./accounts.js";
import { contextOfPath, inFocus } from "./context.js";
import { CONTEXTS } from "./config.js";
import { runsOut, clock, FIVE_HOURS, WEEK } from "./lib/time.js";

const ALERTED = "relevo.alerted";
const KNOWN = "relevo.reviews.known";
const BANNER = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
const HERDR_APP = "dev.herdr.app";

// terminal-notifier lets a click bring Herdr forward and run the alert's action; osascript can only show it.
// Only a find is kept, so installing it later works without a restart.
let tools = null;
const findTools = async () => tools ?? exec("sh", ["-c", 'printf "%s\\n%s\\n" "$(command -v terminal-notifier)" "$(command -v herdr-app)"'])
  .then((r) => {
    const [notifier, app] = r.stdout.split("\n");
    const found = { notifier: notifier || null, app: app || null };
    if (found.notifier) tools = found;
    return found;
  }, () => ({ notifier: null, app: null }));

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// The shell command a click runs: the same Herdr command the toast's own action would.
export function clickCommand(app, action) {
  if (!app || !action?.name || !/^[\w.:-]+$/.test(action.name)) return null;
  return [quote(app), "do", action.name, ...(action.args ? [quote(JSON.stringify(action.args))] : [])].join(" ");
}

// Herdr's toast only shows inside its window, so with another app in front the alert also goes to macOS.
// `group` replaces an earlier banner with the same one, and lets it be taken back.
async function banner(title, body = "", action = null, group = null) {
  if (window()?.active !== false) return;
  const { notifier, app } = await findTools();
  if (!notifier) return exec("osascript", ["-e", BANNER, title, body ?? ""]).catch(() => {});
  const click = clickCommand(app, action);
  exec(notifier, ["-title", title, "-message", body || " ", "-activate", HERDR_APP,
    ...(click ? ["-execute", click] : []), ...(group ? ["-group", group] : [])]).catch(() => {});
}

async function takeBack(group) {
  const { notifier } = await findTools();
  if (notifier) exec(notifier, ["-remove", group]).catch(() => {});
}

function notify(n) {
  toast(n);
  banner(n.title, n.body, n.action);
}

// An agent that starts asking or finishes while Herdr is behind another app; the window has its own marks.
export class AgentWatch {
  tick() {
    const now = new Map(agents().map((a) => [a.address, a]));
    if (this.before) {
      const folders = new Map(panes().map((p) => [p.pane, p.cwd]));
      for (const [address, a] of now) {
        const was = this.before.get(address), group = `relevo-${address}`;
        if (!was || was === a.status) continue;
        // Answered from anywhere: its banner goes too.
        if (was === "blocked") takeBack(group);
        if ((a.status !== "blocked" && a.status !== "done") || !inFocus(contextOfPath(folders.get(a.pane)))) continue;
        const asks = a.status === "blocked", name = a.tab_name || a.space_name || address;
        banner(asks ? `${name} needs you` : `${name} finished`, asks ? shared("relevo.reasons")?.[address] : a.space_name,
          { name: "agent.focus", args: { terminal: address } }, group);
      }
    }
    this.before = new Map([...now].map(([address, a]) => [address, a.status]));
  }
}

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

// One soft alert per account window at 80% and another at 95%, again only after it resets.
// At 95% an account's alert offers to continue its agent with another account, before it stops.
const HANDOFF_AT = 95;
export function quotaAlerts(quotas) {
  const first = shared(ALERTED) == null, seen = { ...(shared(ALERTED) ?? {}) };
  let changed = first;
  for (const [key, q] of Object.entries(quotas)) {
    for (const [name, w] of [["5h", q?.h5], ["7d", q?.d7]]) {
      const full = w?.pct >= HANDOFF_AT, id = `${key}.${name}${full ? ".full" : ""}`;
      // Some sources compute the reset from "now + remaining", so it drifts by seconds.
      const resets = Math.round((w?.resets ?? 0) / 3600);
      if (!w || w.pct < 80 || seen[id] === resets) continue;
      seen[id] = resets;
      changed = true;
      const context = CONTEXTS.find((c) => c.account === key);
      if (first || (context && !inFocus(context.key))) continue;
      playSound("sounds/quota.mp3");
      const handoff = full && [...ACCOUNTS, CODEX].some((p) => p.key === key);
      const out = runsOut(w, name === "5h" ? FIVE_HOURS : WEEK);
      const when = w.pct >= 100 ? "" : out ? ` · 100% at ${clock(out)}` : "";
      notify({
        title: `${accountOf(key).label} at ${w.pct}% (${name})${when}`,
        level: "warning",
        ...(handoff
          ? { body: "Click to continue its agent with another account", action: { name: `relevo.handoff-from-${key}` } }
          : {}),
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

// A merged PR whose worktree is still here offers to clean it up from the Inbox.
export function mergedAlert(e, tree, contextOf) {
  if (!inFocus(contextOf(e.repo))) return;
  const note = !tree ? undefined : tree.dirty ? `${tree.branch}: its worktree has uncommitted changes`
    : `${tree.branch}: its worktree can go, Remove is in the Inbox`;
  notify({ title: e.title, body: note, level: "success", action: { name: "relevo.panel-inbox" } });
}

export function prAlerts(events, contextOf) {
  const shown = events.filter((e) => inFocus(contextOf(e.repo)));
  if (shown.some((e) => LOUD.has(e.kind))) playSound("sounds/review.mp3");
  for (const e of shown) notify({ title: e.title, level: LEVEL[e.kind], action: { name: "relevo.panel-inbox" } });
}
