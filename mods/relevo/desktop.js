import { exec, home, notify, readTextFile, shared, setShared } from "herdr";
import { contextOfPath, inFocus } from "./context.js";
import { desktopChanges, desktopLink, desktopSession, parseStat, showable } from "./lib/desktop.js";

export const DESKTOP = "relevo.desktop";
const LIST = 'd="$1/claude-code-sessions"; [ -d "$d" ] && find "$d" -name "local_*.json" -type f -mtime -7 -exec stat -f "%m %N" {} +';

export const openDesktop = (id) => exec("open", [desktopLink(id)]);

// Keeps what's worth showing in shared state and tells of what changed. A toast only: Desktop has its own
// notifications, and someone outside Herdr is probably in Desktop already.
export class DesktopWatch {
  // `turns` gets every read, for each session's turn receipts.
  constructor(turns = null) {
    this.turns = turns;
    // path -> { mtime, file }: a session file is read again only when it changes.
    this.read = new Map();
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
    return showable([...this.read.values()].map((x) => desktopSession(x.file, now)).filter(Boolean)).sort((a, b) => b.at - a.at);
  }

  async tick() {
    const now = await this.sessions();
    if (!now) return;
    for (const s of desktopChanges(this.before, now)) {
      if (!inFocus(contextOfPath(s.cwd))) continue;
      notify({
        title: s.state === "blocked" ? `${s.project} needs you in Desktop` : `${s.project} finished in Desktop`,
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
