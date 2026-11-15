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

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Markdown read as text: links keep their words, emphasis and code marks go.
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|__|`/g, "").trim();
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].trim();

// A tool call in a few plain words: "editing ui.js", "running the tests".
export function toolWords({ name = "", input = {} }) {
  const file = basename(input.file_path ?? input.notebook_path ?? input.path ?? "");
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return file ? `editing ${file}` : "editing";
  if (name === "Read") return file ? `reading ${file}` : "reading";
  if (name === "Bash") return clip(firstLine(input.description) || `running ${firstLine(input.command).split(" ")[0]}`, 80);
  if (name === "Grep" || name === "Glob") return "searching the code";
  if (name === "WebFetch" || name === "WebSearch") return "searching the web";
  if (name === "Agent" || name === "Task") return clip(firstLine(input.description) || "running a helper", 80);
  if (name === "AskUserQuestion") return clip(`asks: ${firstLine(input.questions?.[0]?.question)}`, 120);
  if (name === "TodoWrite") return "planning";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  return `using ${mcp ? mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ") : name}`;
}

// The tail of a session's transcript: what the agent does now (its last block is a tool call) and its last words.
export function desktopActivity(text) {
  let doing, said = null;
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0 && (doing === undefined || said === null); i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const c of [...e.message.content].reverse()) {
      if (doing === undefined) doing = c.type === "tool_use" ? toolWords(c) : null;
      if (said === null && c.type === "text" && c.text?.trim()) said = clip(plain(c.text), 600);
    }
  }
  return { doing: doing ?? null, said };
}
