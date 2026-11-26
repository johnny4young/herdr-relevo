// Reads token usage from Claude's and Codex's transcripts into a saved state, a range of bytes at a time, so
// the first read of months of files spreads over many short commands and later reads only take what was added.
import { agents, appHome, exec, home, readTextFile, writeTextFile, setShared, terminals, shared, window } from "herdr";
import { allAccounts, providerFor } from "./accounts.js";
import { PROVIDERS, providerOf } from "./lib/providers.js";
import {
  AWK, AGY_AWK, AGY_SCAN, CLAUDE_SCAN, CODEX_SCAN, CONTEXT_SCAN, LIST, addAgy, addClaude, addCodex, contextOf, cutDay, emptyState, parseList,
  parseScan, plan, projectFromPath, prune, reportOf, runFolders, SeenIds,
} from "./lib/usage-scan.js";

const DIR = ".local/state/relevo/usage";
export const REPORT = `${DIR}/report.json`;
// { updated, done, total }: when the report was written, and how far a read in progress is.
export const USAGE = "relevo.usage";
export const AGENT_CONTEXT = "relevo.agentContext";
const SAVE_EVERY = 5;
const PROGRESS_EVERY = 1000;
const STUCK_MS = 15 * 60e3;
// Herdr writes a file of at most 1 MiB: the files' read offsets go in this many parts, and each day's ids in its own file.
const PARTS = 8;
const partOf = (path) => {
  let h = 0;
  for (let i = 0; i < path.length; i += 1) h = (h * 31 + path.charCodeAt(i)) | 0;
  return Math.abs(h) % PARTS;
};

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
    const dir = this.dir = `${home()}/${DIR}`;
    await exec("mkdir", ["-p", dir]);
    this.files = { state: new Saved(`${dir}/state.json`), report: new Saved(`${home()}/${REPORT}`) };
    this.parts = Array.from({ length: PARTS }, (_, i) => new Saved(`${dir}/files-${i}.json`));
    this.days = new Map();
    try {
      // An older save kept the offsets in state.json and every day's ids in seen.json; both still load.
      this.state = { ...emptyState(), ...JSON.parse(await this.files.state.read() ?? "{}"), seen: {} };
      for (const part of this.parts) Object.assign(this.state.files, JSON.parse(await part.read() ?? "{}"));
      const names = await exec("sh", ["-c", 'cd "$1" && for f in seen-*.json; do [ -f "$f" ] && printf "%s\\n" "$f"; done', "sh", dir]).catch(() => null);
      for (const name of (names?.stdout ?? "").split("\n").filter(Boolean)) {
        const saved = new Saved(`${dir}/${name}`);
        this.days.set(name.slice(5, 15), saved);
        this.state.seen[name.slice(5, 15)] = await saved.read() ?? "";
      }
      if (!this.days.size) {
        const old = await new Saved(`${dir}/seen.json`).read();
        if (old) { this.state.seen = JSON.parse(old); this.legacy = true; }
      }
    } catch {
      // A broken save starts over; the ids it held go with it.
      this.state = emptyState();
    }
    await this.files.report.read();
    this.seen = new SeenIds(this.state);
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

  // `complete`: false when a listing failed, so the files it missed are not taken for deleted.
  async list() {
    const listed = new Map();
    let complete = true;
    const add = async (account, dirs, filter = null) => {
      const r = await exec("sh", ["-c", LIST, "sh", ...dirs]).catch(() => null);
      if (r?.code !== 0) complete = false;
      for (const [path, size] of parseList(r?.stdout ?? "")) {
        if (!filter || filter(path)) listed.set(path, { size, account });
      }
    };
    // Antigravity's transcripts are read only once its account was found on this machine.
    const agyOnly = (p) => p.endsWith("/transcript.jsonl");
    for (const a of allAccounts()) {
      const p = providerOf(a), dirs = p.usageDirs(a, home());
      if (dirs.length) await add(a.key, dirs, p === PROVIDERS.agy ? agyOnly : null);
    }
    return { listed, complete };
  }

  async scan() {
    // A reload can strand a scan whose awaits never settle; past STUCK_MS the next one takes over.
    if (this.busy && Date.now() - this.busySince < STUCK_MS) return;
    const run = this.scanRun = (this.scanRun ?? 0) + 1;
    this.busy = true;
    this.busySince = Date.now();
    try {
      if (!this.state) await this.load();
      const cut = cutDay(), { listed, complete } = await this.list(), account = new Map();
      const changed = [];
      for (const [path, { size, account: key }] of listed) {
        const f = this.state.files[path];
        if (f?.size === size) continue;
        // A file that shrank was rewritten: read it again, and the ids keep its messages from counting twice.
        const from = f && f.size < size ? f.size : 0;
        account.set(path, key);
        const kind = key === "agy" || providerFor(key) === PROVIDERS.agy ? "agy" : providerFor(key) === PROVIDERS.codex ? "codex" : "claude";
        changed.push({ path, size, from, prev: from ? f.prev ?? "" : "", kind });
      }
      const batches = [
        ...plan(changed.filter((c) => c.kind === "claude")).map((b) => ["claude", b]),
        ...plan(changed.filter((c) => c.kind === "codex")).map((b) => ["codex", b]),
        ...plan(changed.filter((c) => c.kind === "agy")).map((b) => ["agy", b]),
      ];
      const failed = new Set();
      for (const [i, [kind, batch]] of batches.entries()) {
        if (run !== this.scanRun) return;
        const ranges = batch.filter((r) => !failed.has(r.path));
        if (!ranges.length) continue;
        const specs = ranges.map((r) => (kind === "claude" ? `${r.path}|${r.start}|${r.end}|${r.prev}` : `${r.path}|${r.start}|${r.end}`));
        const cmd = kind === "codex" ? CODEX_SCAN : kind === "agy" ? AGY_SCAN : CLAUDE_SCAN;
        const extra = kind === "codex" ? [] : kind === "agy" ? [AGY_AWK] : [AWK];
        const r = await exec("sh", ["-c", cmd, "sh", ...extra, ...specs])
          .catch(() => null);
        const files = parseScan(r?.stdout ?? "");
        // A range that didn't come back is read again next time, and so are the file's later ones.
        const back = new Set(files.map((f) => f.path));
        for (const x of ranges) if (!back.has(x.path)) failed.add(x.path);
        await this.resolve(files);
        for (const file of files) {
          if (kind === "codex") {
            addCodex(this.state, file, { project: (cwd) => this.project(cwd), cut });
            continue;
          }
          if (kind === "agy") {
            addAgy(this.state, this.seen, file, { account: account.get(file.path) ?? "agy", project: (cwd) => this.project(cwd), cut });
            continue;
          }
          const k = await this.kindOf(file.path);
          addClaude(this.state, this.seen, file, { account: account.get(file.path), kind: k, project: (cwd) => this.project(cwd), cut });
          this.state.files[file.path].kind = k;
        }
        if (Date.now() - (this.progressAt ?? 0) >= PROGRESS_EVERY || i + 1 === batches.length) {
          this.progressAt = Date.now();
          setShared(USAGE, { ...(shared(USAGE) ?? {}), done: i + 1, total: batches.length });
        }
        if ((i + 1) % SAVE_EVERY === 0) await this.save();
      }
      // Nothing read and nothing aged out: the saved report is still right, and a write would redraw every mod.
      if (run !== this.scanRun) return;
      if (prune(this.state, cut, complete ? new Set(listed.keys()) : null) || batches.length || !this.files.report.text || this.legacy) await this.save(true);
    } finally {
      if (run === this.scanRun) {
        this.seen?.forget();
        this.busy = false;
      }
    }
  }

  // Run folders still on disk or still in the run queue: the others would only weigh on the report.
  async keptRuns() {
    const folders = runFolders(this.state), keep = new Set();
    if (!folders.length) return keep;
    const there = await exec("sh", ["-c", 'for d; do [ ! -d "$d" ] || printf "%s\\n" "$d"; done', "sh", ...folders]).catch(() => null);
    for (const folder of (there?.stdout ?? "").split("\n")) if (folder) keep.add(folder);
    try {
      const queue = await exec("cat", [`${appHome()}/relevo-workflow/state.json`]);
      for (const task of JSON.parse(queue.stdout).tasks) if (task.worktree?.path) keep.add(task.worktree.path);
    } catch {
      // no queue yet
    }
    return keep;
  }

  // The offsets and ids go first and state.json last, so an older save is only dropped once its parts are written.
  // A failed save says so in Tokens instead of failing every scan in silence.
  async save(finished = false) {
    const { seen, files, ...rest } = this.state, now = Math.round(Date.now() / 1000);
    try {
      const parts = Array.from({ length: PARTS }, () => ({}));
      for (const [path, file] of Object.entries(files)) parts[partOf(path)][path] = file;
      for (const [i, part] of parts.entries()) await this.parts[i].write(JSON.stringify(part));
      for (const [day, ids] of Object.entries(seen)) {
        if (!this.days.has(day)) this.days.set(day, new Saved(`${this.dir}/seen-${day}.json`));
        await this.days.get(day).write(ids);
      }
      const gone = [...this.days.keys()].filter((day) => !(day in seen));
      if (gone.length || this.legacy) {
        await exec("rm", ["-f", ...gone.map((day) => this.days.get(day).path), ...(this.legacy ? [`${this.dir}/seen.json`] : [])]);
        for (const day of gone) this.days.delete(day);
        this.legacy = false;
      }
      await this.files.state.write(JSON.stringify(rest));
      await this.files.report.write(JSON.stringify(reportOf(this.state, now, await this.keptRuns())));
    } catch (e) {
      setShared(USAGE, { ...(shared(USAGE) ?? {}), done: 0, total: 0, error: `Token usage could not be saved: ${e?.message ?? e}` });
      return;
    }
    setShared(USAGE, finished ? { updated: now } : { ...(shared(USAGE) ?? {}), updated: now, error: null });
  }
}

export async function readReport() {
  const path = `${home()}/${REPORT}`;
  try {
    return JSON.parse((await new Saved(path).read()) || (await readTextFile(path)) || "null");
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
