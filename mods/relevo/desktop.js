import { exec, home, notify, readTextFile, shared, setShared } from "herdr";
import { contextOfPath, inFocus } from "./context.js";
import { desktopActivity, desktopChanges, desktopLink, desktopSession, parseStat, showable } from "./lib/desktop.js";

export const DESKTOP = "relevo.desktop";
const LIST = 'd="$1/claude-code-sessions"; [ -d "$d" ] && find "$d" -name "local_*.json" -type f -mtime -7 -exec stat -f "%m %N" {} +';
// Each session's Claude Code transcript, in whichever account folder it lives.
const TRANSCRIPTS = 'h=$1; shift; for id in "$@"; do for f in "$h"/.claude*/projects/*/"$id".jsonl; do [ -f "$f" ] && stat -f "%m %N" "$f"; done; done';
const TAIL_BYTES = 131072;

export const openDesktop = (id) => exec("open", [desktopLink(id)]);
// What desktopSession reads of a session file; the rest (MCP configs and the like) can weigh hundreds of KB each.
export function slim(d) {
  if (!d || typeof d !== "object") return null;
  const s = d.postTurnSummary ?? {};
  return {
    isArchived: d.isArchived, sessionId: d.sessionId, cliSessionId: d.cliSessionId, title: d.title, cwd: d.cwd, originCwd: d.originCwd,
    latestUserFrameAt: d.latestUserFrameAt, lastTurnEdgeAt: d.lastTurnEdgeAt, lastActivityAt: d.lastActivityAt,
    postTurnSummary: { status_category: s.status_category, needs_action: s.needs_action, status_detail: s.status_detail },
  };
}

// Reads the tail of each listed transcript whose time changed; `cache` keeps path -> { mtime, activity }. Read only.
export async function readTails(cache, listed) {
  for (const path of cache.keys()) if (!listed.has(path)) cache.delete(path);
  for (const [path, mtime] of listed) {
    if (cache.get(path)?.mtime === mtime) continue;
    const tail = await exec("tail", ["-c", String(TAIL_BYTES), path]).catch(() => null);
    cache.set(path, { mtime, activity: desktopActivity(tail?.stdout) });
  }
  return cache;
}

// Keeps what's worth showing in shared state and tells of what changed. A toast only: Desktop has its own
// notifications, and someone outside Herdr is probably in Desktop already.
export class DesktopWatch {
  // `turns` gets every read, for each session's turn receipts.
  constructor(turns = null) {
    this.turns = turns;
    // path -> { mtime, file }: a session file is read again only when it changes.
    this.read = new Map();
    // transcript path -> { mtime, activity }, the same way.
    this.tails = new Map();
  }

  async sessions() {
    const r = await exec("sh", ["-c", LIST, "sh", `${home()}/Library/Application Support/Claude`]).catch(() => null);
    if (!r) return null;
    const listed = parseStat(r.stdout);
    for (const path of this.read.keys()) if (!listed.has(path)) this.read.delete(path);
    for (const [path, mtime] of listed) {
      if (this.read.get(path)?.mtime === mtime) continue;
      let file = null;
      try {
        // cat past readTextFile's 1 MiB: a long session's file can grow beyond it.
        const text = await readTextFile(path).catch(() => null) ?? (await exec("cat", [path])).stdout;
        file = slim(JSON.parse(text || "null"));
      } catch {
        file = null;
      }
      this.read.set(path, { mtime, file });
    }
    const now = Date.now();
    const shown = showable([...this.read.values()].map((x) => desktopSession(x.file, now)).filter(Boolean)).sort((a, b) => b.at - a.at);
    const said = await this.activity(shown.map((s) => s.cli).filter((id) => /^[0-9a-f-]{36}$/.test(id ?? "")));
    return shown.map((s) => ({ ...s, ...(said.get(s.cli) ?? { doing: null, said: null }) }));
  }

  // What each session is doing and last said, from the tail of its transcript.
  async activity(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const r = await exec("sh", ["-c", TRANSCRIPTS, "sh", home(), ...ids]).catch(() => null);
    await readTails(this.tails, parseStat(r?.stdout ?? ""));
    for (const [path, x] of this.tails) out.set(path.split("/").pop().replace(/\.jsonl$/, ""), x.activity);
    return out;
  }

  async tick() {
    const now = await this.sessions();
    if (!now) return;
    for (const s of desktopChanges(this.before, now)) {
      if (!inFocus(contextOfPath(s.cwd))) continue;
      notify({
        title: s.state === "blocked" ? `${s.project} needs you in Claude Desktop` : `${s.project} finished in Claude Desktop`,
        body: s.needs || s.title,
        level: s.state === "blocked" ? "warning" : "success",
        action: { name: "relevo.panel-reviews" },
      });
    }
    this.before = now;
    this.turns?.desktop(now);
    if (JSON.stringify(shared(DESKTOP) ?? []) !== JSON.stringify(now)) setShared(DESKTOP, now);
  }
}
