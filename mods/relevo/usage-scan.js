// Reads token usage from Claude's and Codex's transcripts into a saved state, a range of bytes at a time, so
// the first read of months of files spreads over many short commands and later reads only take what was added.
import { agents, exec, home, readTextFile, writeTextFile, setShared, terminals, shared, window } from "herdr";
import { ACCOUNTS } from "./accounts.js";
import {
  AWK, CLAUDE_SCAN, CODEX_SCAN, CONTEXT_SCAN, LIST, addClaude, addCodex, contextOf, cutDay, emptyState, parseList,
  parseScan, plan, projectFromPath, prune, reportOf, seenSet,
} from "./lib/usage-scan.js";

const DIR = ".local/state/relevo/usage";
export const REPORT = `${DIR}/report.json`;
// { updated, done, total }: when the report was written, and how far a read in progress is.
export const USAGE = "relevo.usage";
export const AGENT_CONTEXT = "relevo.agentContext";
const SAVE_EVERY = 5;
const PROGRESS_EVERY = 1000;

// writeTextFile only replaces what it was given, so each file remembers what it last read or wrote.
class Saved {
  constructor(path) {
    this.path = path;
    this.text = null;
  }

  // cat, because readTextFile stops at 1 MiB.
  async read() {
    const r = await exec("cat", [this.path]).catch(() => null);
    this.text = r?.code === 0 ? r.stdout : null;
    return this.text;
  }

  async write(text) {
    if (text === this.text) return;
    try {
      await writeTextFile(this.path, text, this.text);
    } catch {
      await this.read();
      await writeTextFile(this.path, text, this.text);
    }
    this.text = text;
  }
}

const basename = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop() || "unknown";

export class UsageScanner {
  async load() {
    const dir = `${home()}/${DIR}`;
    await exec("mkdir", ["-p", dir]);
    this.files = { state: new Saved(`${dir}/state.json`), seen: new Saved(`${dir}/seen.json`), report: new Saved(`${home()}/${REPORT}`) };
    try {
      this.state = { ...emptyState(), ...JSON.parse(await this.files.state.read() ?? "{}") };
      this.state.seen = JSON.parse(await this.files.seen.read() ?? "{}");
    } catch {
      // A broken save starts over; the ids it held go with it.
      this.state = emptyState();
    }
    await this.files.report.read();
    this.seen = seenSet(this.state);
  }

  project(cwd) {
    return projectFromPath(cwd) ?? this.state.projects[cwd] ?? basename(cwd);
  }

  // A folder outside the known worktree layouts asks git once which repo it belongs to.
  async resolve(files) {
    const cwds = new Set(files.flatMap((f) => f.msgs.map((m) => m.cwd)).concat(files.map((f) => f.cwd)));
    for (const cwd of cwds) {
      if (!cwd || projectFromPath(cwd) || cwd in this.state.projects) continue;
      const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
      const common = r?.code === 0 ? r.stdout.trim().replace(/\/+$/, "") : "";
      this.state.projects[cwd] = common.endsWith("/.git") ? basename(common.slice(0, -5)) : basename(cwd);
    }
  }

  async kindOf(path) {
    if (!path.includes("/subagents/")) return "main";
    const known = this.state.files[path]?.kind;
    if (known) return known;
    try {
      return `sub:${JSON.parse(await readTextFile(path.replace(/\.jsonl$/, ".meta.json")) ?? "{}").agentType ?? "unknown"}`;
    } catch {
      return "sub:unknown";
    }
  }

  async list() {
    const listed = new Map();
    const add = async (account, dirs) => {
      const r = await exec("sh", ["-c", LIST, "sh", ...dirs]).catch(() => null);
      for (const [path, size] of parseList(r?.stdout ?? "")) listed.set(path, { size, account });
    };
    for (const a of ACCOUNTS.filter((x) => x.claudeDir)) await add(a.key, [`${home()}/${a.claudeDir}/projects`]);
    await add("codex", [`${home()}/.codex/sessions`, `${home()}/.codex/archived_sessions`]);
    return listed;
  }

  async scan() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.state) await this.load();
      const cut = cutDay(), listed = await this.list(), account = new Map();
      const changed = [];
      for (const [path, { size, account: key }] of listed) {
        const f = this.state.files[path];
        if (f?.size === size) continue;
        // A file that shrank was rewritten: read it again, and the ids keep its messages from counting twice.
        const from = f && f.size < size ? f.size : 0;
        account.set(path, key);
        changed.push({ path, size, from, prev: from ? f.prev ?? "" : "", codex: key === "codex" });
      }
      const batches = [...plan(changed.filter((c) => !c.codex)).map((b) => [false, b]), ...plan(changed.filter((c) => c.codex)).map((b) => [true, b])];
      const failed = new Set();
      for (const [i, [codex, batch]] of batches.entries()) {
        const ranges = batch.filter((r) => !failed.has(r.path));
        if (!ranges.length) continue;
        const specs = ranges.map((r) => (codex ? `${r.path}|${r.start}|${r.end}` : `${r.path}|${r.start}|${r.end}|${r.prev}`));
        const r = await exec("sh", ["-c", codex ? CODEX_SCAN : CLAUDE_SCAN, "sh", ...(codex ? [] : [AWK]), ...specs])
          .catch(() => null);
        const files = parseScan(r?.stdout ?? "");
        // A range that didn't come back is read again next time, and so are the file's later ones.
        const back = new Set(files.map((f) => f.path));
        for (const x of ranges) if (!back.has(x.path)) failed.add(x.path);
        await this.resolve(files);
        for (const file of files) {
          if (codex) {
            addCodex(this.state, file, { project: (cwd) => this.project(cwd), cut });
            continue;
          }
          const kind = await this.kindOf(file.path);
          addClaude(this.state, this.seen, file, { account: account.get(file.path), kind, project: (cwd) => this.project(cwd), cut });
          this.state.files[file.path].kind = kind;
        }
        if (Date.now() - (this.progressAt ?? 0) >= PROGRESS_EVERY || i + 1 === batches.length) {
          this.progressAt = Date.now();
          setShared(USAGE, { ...(shared(USAGE) ?? {}), done: i + 1, total: batches.length });
        }
        if ((i + 1) % SAVE_EVERY === 0) await this.save();
      }
      // Nothing read and nothing aged out: the saved report is still right, and a write would redraw every mod.
      if (prune(this.state, cut, new Set(listed.keys())) || batches.length || !this.files.report.text) await this.save(true);
    } finally {
      this.busy = false;
    }
  }

  async save(finished = false) {
    const { seen, ...rest } = this.state, now = Math.round(Date.now() / 1000);
    await this.files.seen.write(JSON.stringify(seen));
    await this.files.state.write(JSON.stringify(rest));
    await this.files.report.write(JSON.stringify(reportOf(this.state, now)));
    setShared(USAGE, finished ? { updated: now } : { ...(shared(USAGE) ?? {}), updated: now });
  }
}

export async function readReport() {
  try {
    return JSON.parse(await readTextFile(`${home()}/${REPORT}`) ?? "null");
  } catch {
    return null;
  }
}

// Each live agent's model, context and cache life, from the end of its transcript, for the agents list. Only a
// transcript whose agent worked or took a turn since the last read is read again; the others keep their values.
export class ContextWatch {
  constructor() {
    // address -> "path|turn" when last read
    this.read = new Map();
  }

  async tick() {
    if (this.busy || window()?.active === false) return;
    this.busy = true;
    try {
      await this.publish();
    } finally {
      this.busy = false;
    }
  }

  async publish() {
    const live = terminals().filter((k) => k.state === "live" && k.labels?.["agent.transcript"]);
    const working = new Set(agents().filter((a) => a.status === "working").map((a) => a.address));
    const sign = (k) => `${k.labels["agent.transcript"]}|${k.turn ?? ""}`;
    const stale = live.filter((k) => working.has(k.address) || this.read.get(k.address) !== sign(k));
    const before = shared(AGENT_CONTEXT) ?? {}, next = {};
    for (const k of live) if (before[k.address] && !stale.includes(k)) next[k.address] = before[k.address];
    if (stale.length) {
      const paths = [...new Set(stale.map((k) => k.labels["agent.transcript"]))];
      const r = await exec("sh", ["-c", CONTEXT_SCAN, "sh", AWK, ...paths]).catch(() => null);
      if (!r) return;
      const found = new Map(parseScan(r.stdout).map((f) => [f.path, contextOf(f)]));
      for (const k of stale) {
        const c = found.get(k.labels["agent.transcript"]);
        if (c) next[k.address] = c;
        this.read.set(k.address, sign(k));
      }
    }
    for (const address of this.read.keys()) if (!live.some((k) => k.address === address)) this.read.delete(address);
    const value = Object.keys(next).length ? next : null;
    if (JSON.stringify(value) !== JSON.stringify(shared(AGENT_CONTEXT) ?? null)) setShared(AGENT_CONTEXT, value);
  }
}
