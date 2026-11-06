// A receipt for each agent turn, Herdr's and Claude Desktop's: how much it took, and how much went to subagents.
// A heavy turn gets an alert; the Tokens dialog lists the day's heaviest.
import { exec, home, notify, shared, setShared } from "herdr";
import { ACCOUNTS } from "./accounts.js";
import { compact } from "./lib/usage.js";
import { AWK, CLAUDE_SCAN, parseList, parseScan, plan } from "./lib/usage-scan.js";
import { SIZES, heavy, keepReceipts, receiptOf, turnRanges } from "./lib/turns.js";

export const TURNS = "relevo.turns";
const FIND = 'for p; do for f in $p; do [ -f "$f" ] && echo "$f"; done; done';

const sizes = async (transcript) => parseList((await exec("sh", ["-c", SIZES, "sh", transcript]).catch(() => null))?.stdout ?? "");

async function measure(before, transcript, since) {
  const ranges = turnRanges(before, await sizes(transcript));
  const files = [];
  for (const batch of plan(ranges)) {
    const specs = batch.map((r) => `${r.path}|${r.start}|${r.end}|`);
    const r = await exec("sh", ["-c", CLAUDE_SCAN, "sh", AWK, ...specs]).catch(() => null);
    files.push(...parseScan(r?.stdout ?? ""));
  }
  return receiptOf(before, files, since);
}

export class TurnWatch {
  constructor() {
    // key -> { transcript, sizes at the start, when }
    this.open = new Map();
    this.paths = new Map();
  }

  // Marked open at once, so a second tick before the sizes arrive doesn't start it again.
  start(key, transcript, where, surface) {
    if (this.open.has(key) || !transcript) return;
    this.open.set(key, { transcript, where, surface, before: sizes(transcript), at: Date.now() / 1000 });
  }

  async end(key) {
    const turn = this.open.get(key);
    if (!turn) return;
    const { where, surface } = turn;
    this.open.delete(key);
    const r = await measure(await turn.before, turn.transcript, turn.at - 1);
    if (!r.write && !r.output) return;
    const receipt = { ...r, where, surface, at: Math.round(Date.now() / 1000), took: Math.round(Date.now() / 1000 - turn.at) };
    setShared(TURNS, keepReceipts(shared(TURNS), receipt));
    if (!heavy(r)) return;
    const subs = r.subs ? `${r.subs} ${r.subs === 1 ? "subagent" : "subagents"}: ${compact(r.subWrite + r.subOutput)} · ` : "";
    notify({
      title: `${where} · that turn took ${compact(r.write + r.output)}`,
      body: `${subs}main conversation: ${compact(r.write + r.output - r.subWrite - r.subOutput)}`,
      level: "info",
      action: { name: "relevo.usage" },
    });
  }

  // Herdr's agents: a turn runs while the agent works; a question pauses it rather than ending it.
  // An agent that left the list ended its turn too.
  agents(list, labels) {
    const listed = new Set(list.map((a) => a.address));
    for (const a of list) {
      const transcript = labels.get(a.address)?.["agent.transcript"];
      if (a.status === "working") this.start(a.address, transcript, a.tab_name || a.space_name || a.address, "terminal");
      else if (a.status !== "blocked") this.end(a.address);
    }
    for (const key of this.open.keys()) if (!key.startsWith("desktop:") && !listed.has(key)) this.end(key);
  }

  // Desktop's sessions, from its own files; the transcript is found once by the session's CLI id.
  // A finished session leaves the list Relevo shows, so anything not working now ends its turn.
  async desktop(sessions) {
    const working = new Set();
    for (const s of sessions.filter((x) => x.state === "working")) {
      const key = `desktop:${s.id}`;
      working.add(key);
      this.start(key, await this.transcriptOf(s.cli), s.title && s.title !== s.project ? `${s.project} · ${s.title}` : s.project, "desktop");
    }
    for (const key of [...this.open.keys()]) if (key.startsWith("desktop:") && !working.has(key)) await this.end(key);
  }

  async transcriptOf(id) {
    if (!id || !/^[\w-]+$/.test(id)) return null;
    if (!this.paths.has(id)) {
      const globs = ACCOUNTS.filter((a) => a.claudeDir).map((a) => `${home()}/${a.claudeDir}/projects/*/${id}.jsonl`);
      const r = await exec("sh", ["-c", FIND, "sh", ...globs]).catch(() => null);
      const found = r?.stdout.split("\n").find(Boolean) ?? null;
      if (!found) return null;
      this.paths.set(id, found);
    }
    return this.paths.get(id);
  }
}
