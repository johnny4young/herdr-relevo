// Claude Code sessions in terminals outside Herdr, from the notes the hook leaves; pure, so tests can feed it.
import { projectFromPath } from "./usage-scan.js";

const APPS = { Apple_Terminal: "Terminal", "iTerm.app": "iTerm", vscode: "VS Code", ghostty: "Ghostty", WezTerm: "WezTerm", WarpTerminal: "Warp", tmux: "tmux", zed: "Zed" };
// A transcript written this recently, after the last note, means a turn is running.
const FRESH_S = 120;
const basename = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();

// A note, its transcript's modification time (s) and what the transcript says, as a session row.
export function elsewhereSession(note, mtime, activity, now = Date.now() / 1000) {
  if (!note?.session) return null;
  const fresh = mtime && now - mtime < FRESH_S, moved = mtime && mtime > note.at + 2;
  const state = fresh && moved ? "working" : note.event === "PermissionRequest" ? "blocked" : note.event === "Stop" ? "review" : fresh ? "working" : "idle";
  return {
    id: note.session, cwd: note.cwd || null, project: projectFromPath(note.cwd) ?? basename(note.cwd),
    app: APPS[note.app] ?? note.app ?? "", bundle: note.bundle || null, at: Math.round(Math.max(note.at ?? 0, mtime ?? 0)), state,
    needs: state === "blocked" ? `asks to use ${note.tool || "a tool"}` : "", doing: activity?.doing ?? null, said: activity?.said ?? null,
  };
}
