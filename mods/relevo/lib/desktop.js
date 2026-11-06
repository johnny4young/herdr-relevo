// Claude Desktop's Claude Code sessions, from the files it keeps per session; pure, so the tests can feed it fixtures.
import { projectFromPath } from "./usage-scan.js";

const HOUR = 3600;
// A turn with no activity for this long crashed or was left behind; it isn't running.
const RUNNING_FOR_MS = 15 * 60 * 1000;
const basename = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();

// `stat -f '%m %N'` lines: modification time and path.
export function parseStat(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^(\d+) (.+)$/.exec(line);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

// What a session file says, or null for an archived one. A message newer than the last turn's end means
// a turn is running, unless nothing has happened for a while.
export function desktopSession(d, nowMs = Date.now()) {
  if (!d || d.isArchived) return null;
  const summary = d.postTurnSummary ?? {};
  const user = d.latestUserFrameAt ?? 0, edge = d.lastTurnEdgeAt ?? 0, active = d.lastActivityAt ?? 0;
  const state = user > edge && nowMs - active < RUNNING_FOR_MS ? "working"
    : summary.status_category === "blocked" || summary.needs_action ? "blocked"
      : { review_ready: "review", completed: "done" }[summary.status_category] ?? "idle";
  return {
    id: d.sessionId, cli: d.cliSessionId ?? null, title: (d.title ?? "").slice(0, 120), cwd: d.cwd ?? null,
    project: projectFromPath(d.cwd) ?? basename(d.originCwd || d.cwd),
    at: Math.round(active / 1000), state, needs: (summary.needs_action ?? "").slice(0, 300), detail: (summary.status_detail ?? "").slice(0, 300),
  };
}
// A question stays worth showing for days; a finished turn only while it's fresh.
const KEPT = { blocked: 7 * 24 * HOUR, working: 24 * HOUR, review: 24 * HOUR };

export const desktopLink = (id) => `claude://code/continue?session=${encodeURIComponent(id)}`;

export const showable = (sessions, now = Date.now() / 1000) =>
  sessions.filter((s) => KEPT[s.state] && now - s.at < KEPT[s.state]);

// What changed since the last read; the first read only sets the baseline.
export function desktopChanges(before, sessions) {
  if (!before) return [];
  const was = new Map(before.map((s) => [s.id, s.state]));
  return sessions.filter((s) => {
    const prior = was.get(s.id);
    if (s.state === "blocked") return prior !== "blocked";
    return s.state === "review" && prior === "working";
  });
}

export const desktopKey = (s) => `desktop:${s.id}`;
// Settled until the session does something after the mark.
export const isSettled = (s, marks) => (marks?.[desktopKey(s)] ?? 0) >= s.at;
