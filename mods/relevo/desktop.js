import { exec, home, notify, readTextFile, shared, setShared } from "herdr";
import { contextOfPath, inFocus } from "./context.js";
import { desktopActivity, desktopChanges, desktopLink, desktopSession, parseStat, showable } from "./lib/desktop.js";

export const DESKTOP = "relevo.desktop";
const LIST = 'd="$1/claude-code-sessions"; [ -d "$d" ] && find "$d" -name "local_*.json" -type f -mtime -7 -exec stat -f "%m %N" {} +';
// Each session's Claude Code transcript, in whichever account folder it lives.
const TRANSCRIPTS = 'h=$1; shift; for id in "$@"; do for f in "$h"/.claude*/projects/*/"$id".jsonl; do [ -f "$f" ] && stat -f "%m %N" "$f"; done; done';
const TAIL_BYTES = 131072;

export const openDesktop = (id) => exec("open", [desktopLink(id)]);

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
        file = JSON.parse(text || "null");
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

  // What each session is doing and last said, from the tail of its transcript; read only, and only when it changed.
  async activity(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const r = await exec("sh", ["-c", TRANSCRIPTS, "sh", home(), ...ids]).catch(() => null);
    const listed = parseStat(r?.stdout ?? "");
    for (const path of this.tails.keys()) if (!listed.has(path)) this.tails.delete(path);
    for (const [path, mtime] of listed) {
      if (this.tails.get(path)?.mtime !== mtime) {
        const tail = await exec("tail", ["-c", String(TAIL_BYTES), path]).catch(() => null);
        this.tails.set(path, { mtime, activity: desktopActivity(tail?.stdout) });
      }
      out.set(path.split("/").pop().replace(/\.jsonl$/, ""), this.tails.get(path).activity);
    }
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
