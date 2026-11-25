// Claude Code in terminals outside Herdr: the hook's notes, each with what its transcript says, in shared state.
import { exec, home, shared, setShared } from "herdr";
import { parseStat, showable } from "./lib/desktop.js";
import { elsewhereSession } from "./lib/elsewhere.js";
import { DESKTOP, readTails } from "./desktop.js";

export const ELSEWHERE = "relevo.elsewhere";
// Every note, one per line; a note a week old belongs to a session that ended without saying so.
const NOTES = 'd="$1/.local/state/relevo/elsewhere"; [ -d "$d" ] || exit 0; find "$d" -name "*.json" -mtime +7 -delete; for f in "$d"/*.json; do [ -f "$f" ] && head -c 4096 "$f" && echo; done';
const STAT = 'for f in "$@"; do [ -f "$f" ] && stat -f "%m %N" -- "$f"; done';

export class ElsewhereWatch {
  constructor() {
    this.tails = new Map();
  }

  async sessions() {
    const r = await exec("sh", ["-c", NOTES, "sh", home()]).catch(() => null);
    if (!r) return null;
    const notes = r.stdout.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((n) => n?.session);
    // Claude Desktop lists its own sessions.
    const desktop = new Set((shared(DESKTOP) ?? []).map((s) => s.cli));
    const mine = notes.filter((n) => !desktop.has(n.session) && n.transcript?.endsWith(".jsonl"));
    const st = mine.length ? await exec("sh", ["-c", STAT, "sh", ...mine.map((n) => n.transcript)]).catch(() => null) : null;
    const listed = parseStat(st?.stdout ?? "");
    await readTails(this.tails, listed);
    const now = Date.now() / 1000;
    return showable(mine.map((n) => elsewhereSession(n, listed.get(n.transcript), this.tails.get(n.transcript)?.activity, now)).filter(Boolean), now)
      .sort((a, b) => b.at - a.at);
  }

  async tick() {
    const now = await this.sessions();
    if (now && JSON.stringify(shared(ELSEWHERE) ?? []) !== JSON.stringify(now)) setShared(ELSEWHERE, now);
  }
}
