// Token usage from Claude's and Codex's transcripts: the shell pulls out the few fields per message, and these
// pure functions add them up, so the tests can feed them fixtures.
import { dayKey } from "./usage.js";
import { WORKTREES, runFolder } from "./run-folder.js";

const HERDR_WORKTREES = `/${WORKTREES.join("/")}/`;

export const KEEP_DAYS = 31;
const PAUSE_SECONDS = 3600;
// Below this, a write after a pause is new work rather than the conversation being cached again.
const PAUSE_MIN_WRITE = 20000;
const SURFACES = { "claude-desktop": "desktop", cli: "terminal" };
// A message id's random tail is enough to tell two apart, and keeps the saved list small.
const ID_LENGTH = 12;

// One awk reads a whole batch: an "F" line starts each file's range, then the lines grep kept. Per assistant
// message it prints one line: the message's id and model open the line, its usage closes the message, and the
// line's own time, folder and session follow its requestId. Text inside a message is escaped and never
// matches. Plain index() lookups: lines run to megabytes and regexes over them took minutes.
export const AWK = String.raw`
function str(s, key,   i, r) { i = index(s, "\"" key "\":\""); if (!i) return ""; r = substr(s, i + length(key) + 4); return substr(r, 1, index(r, "\"") - 1) }
function quoted(s, key,   i, r, j, c) {
  i = index(s, "\"" key "\":\""); if (!i) return ""; r = substr(s, i + length(key) + 4)
  for (j = 1; j <= length(r); j++) { c = substr(r, j, 1); if (c == "\\") j++; else if (c == "\"") return substr(r, 1, j - 1) }
  return ""
}
function num(s, key,   i) { i = index(s, "\"" key "\":"); return i ? substr(s, i + length(key) + 3, 24) + 0 : 0 }
function flush() { if (title != "") print "T\t" sid "\t" title; title = "" }
/^F\t/ { flush(); split($0, a, "\t"); print "F\t" a[2] "\t" a[3]; prev = a[4]; next }
index($0, "\"type\":\"assistant\"") == 0 {
  t = quoted($0, "customTitle"); if (t == "") t = quoted($0, "aiTitle")
  if (t != "") { title = t; sid = str($0, "sessionId") }
  next
}
{
  head = substr($0, 1, 400)
  id = str(head, "id")
  if (substr(id, 1, 4) != "msg_" || id == prev) next
  p = index($0, "\"usage\":{\"input_tokens\":")
  if (!p) next
  prev = id
  u = substr($0, p, 1000)
  q = index($0, ",\"requestId\":\"")
  own = q ? substr($0, q) : substr($0, length($0) > 4000 ? length($0) - 4000 : 1)
  print "M\t" id "\t" str(own, "timestamp") "\t" str(head, "model") "\t" str(own, "entrypoint") "\t" num(u, "input_tokens") "," num(u, "cache_creation_input_tokens") "," num(u, "cache_read_input_tokens") "," num(u, "output_tokens") "\t" num(u, "ephemeral_1h_input_tokens") "," num(u, "ephemeral_5m_input_tokens") "\t" str(own, "sessionId") "\t" str(own, "cwd")
}
END { flush() }`;

// Each file's size, for what changed since the last read.
export const LIST = String.raw`for d; do [ ! -d "$d" ] || find "$d" -name '*.jsonl' -type f -mtime -${KEEP_DAYS} -exec wc -c {} +; done 2>/dev/null`;

// Bytes from the 64 KiB block holding a start up to an end: BSD tail -c +N takes half a minute on a big file, dd
// a second. A line cut at either end lacks its time and is skipped; what the overlap repeats, the ids drop.
const READ = String.raw`from() { dd if="$1" bs=65536 skip=$(($2 / 65536)) 2>/dev/null | head -c $(($3 - $2 / 65536 * 65536)); }
`;

// Args: the awk program, then "file|start|end|last message id" per range. Parse from the right so "|" in paths
// never shifts into start/end, and validate digits before arithmetic expansion.
export const CLAUDE_SCAN = String.raw`${READ}prog=$1; shift
for spec; do
  prev=${"${spec##*|}"}; rest=${"${spec%|*}"}; end=${"${rest##*|}"}; rest=${"${rest%|*}"}; start=${"${rest##*|}"}; f=${"${rest%|*}"}
  case "$start:$end" in ""|*[!0-9:]*) continue ;; esac
  [ -n "$start" ] && [ -n "$end" ] && [ -f "$f" ] || continue
  printf 'F\t%s\t%s\t%s\n' "$f" "$end" "$prev"
  from "$f" "$start" "$end"
  printf '\n'
done | LC_ALL=C grep -a -e '^F' -e '"usage":{"input_tokens"' -e 'Title":"' | LC_ALL=C awk "$prog"`;

// Args: "file|start|end" per range. Codex writes its running total in each token_count event.
export const CODEX_SCAN = String.raw`${READ}for spec; do
  end=${"${spec##*|}"}; rest=${"${spec%|*}"}; start=${"${rest##*|}"}; f=${"${rest%|*}"}
  case "$start:$end" in ""|*[!0-9:]*) continue ;; esac
  [ -n "$start" ] && [ -n "$end" ] && [ -f "$f" ] || continue
  printf 'F\t%s\t%s\t' "$f" "$end"
  if [ "$start" = 0 ]; then head -c 65536 "$f" | LC_ALL=C grep -ao '"cwd":"[^"]*"' | head -n 1 | tr -d '\n'; fi
  printf '\n'
  from "$f" "$start" "$end" | LC_ALL=C grep -a '"token_count"' | LC_ALL=C grep -aoE '"timestamp":"[^"]*"|"total_token_usage":\{[^}]*\}'
done`;

// Antigravity compact transcripts: PLANNER_RESPONSE lines carry created_at, model, input_tokens, cache_read_tokens and output_tokens.
export const AGY_AWK = String.raw`
function str(s, key,   i, r) { i = index(s, "\"" key "\":\""); if (!i) return ""; r = substr(s, i + length(key) + 4); return substr(r, 1, index(r, "\"") - 1) }
function num(s, key,   i) { i = index(s, "\"" key "\":"); return i ? substr(s, i + length(key) + 3, 24) + 0 : 0 }
/^F\t/ { split($0, a, "\t"); print "F\t" a[2] "\t" a[3]; next }
# Tool calls ride on planner lines; their args hold JSON-encoded values: "Path":"\"/file\"",
# "DirectoryPath":"\"/dir\"". C names a file, D a folder; a SearchPath is either.
index($0, "Path\":\"\\\"/") > 0 {
  i = index($0, "Path\":\"\\\"/"); r = substr($0, i + 9); p = substr(r, 1, index(r, "\\\"") - 1)
  dir = substr($0, i - 9, 9) == "Directory" || (substr($0, i - 6, 6) == "Search" && p !~ /\.[^\/]*$/)
  if (p != "" && index(p, "/.gemini/") == 0) print (dir ? "D" : "C") "\t" p
}
# A line cut at a block start loses its leading step_index, and step 0 would count it again.
index($0, "\"type\":\"PLANNER_RESPONSE\"") > 0 && index($0, "\"step_index\":") > 0 {
  inp = num($0, "input_tokens"); rd = num($0, "cache_read_tokens"); out = num($0, "output_tokens")
  if (inp > 0 || rd > 0 || out > 0) {
    print "A\t" num($0, "step_index") "\t" str($0, "created_at") "\t" str($0, "model") "\t" inp "," rd "," out
  }
}`;

// Args: the awk program, then "file|start|end" per range for Antigravity transcripts.
export const AGY_SCAN = String.raw`${READ}prog=$1; shift
for spec; do
  end=${"${spec##*|}"}; rest=${"${spec%|*}"}; start=${"${rest##*|}"}; f=${"${rest%|*}"}
  case "$start:$end" in ""|*[!0-9:]*) continue ;; esac
  [ -n "$start" ] && [ -n "$end" ] && [ -f "$f" ] || continue
  printf 'F\t%s\t%s\t\n' "$f" "$end"
  from "$f" "$start" "$end"
  printf '\n'
done | LC_ALL=C grep -a -e '^F' -e '"type":"PLANNER_RESPONSE"' -e 'Path":"\\"/' | LC_ALL=C awk "$prog"`;

const CHUNK = 100e6;
// Each file in a batch starts a few processes, which add up on a busy machine.
const MAX_RANGES = 400;
// A message line longer than this, cut at a range's end, isn't seen whole by either range.
const OVERLAP = 8e6;

// Byte ranges for what each file added since its last read, in batches of about CHUNK bytes per exec.
export function plan(files, chunk = CHUNK, overlap = OVERLAP) {
  const ranges = [];
  for (const { path, from, size, prev } of files) {
    for (let start = from; start < size;) {
      const end = Math.min(size, start + chunk);
      ranges.push({ path, start, end, prev: start === from ? prev : "", last: end === size });
      if (end === size) break;
      start = end - overlap;
    }
  }
  const batches = [];
  let bytes = Infinity;
  for (const r of ranges) {
    if (bytes + r.end - r.start > chunk || batches.at(-1).length >= MAX_RANGES) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1).push(r);
    bytes += r.end - r.start;
  }
  return batches;
}

// Args: the awk program, then transcripts: the newest message of each.
export const CONTEXT_SCAN = String.raw`${READ}prog=$1; shift
for f; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f" | tr -d ' ')
  printf 'F\t%s\t%s\t\n' "$f" "$size"
  from "$f" $((size > 524288 ? size - 524288 : 0)) "$size" | LC_ALL=C grep -a '"usage":{' | LC_ALL=C grep -a '"type":"assistant"' | tail -n 1
done | LC_ALL=C awk "$prog"`;

const unjson = (s) => {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
};

// `wc -c` lines: size and path; its "total" lines go.
export function parseList(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+) (.+)$/.exec(line);
    if (m && m[2] !== "total") out.set(m[2], Number(m[1]));
  }
  return out;
}

export function parseScan(text) {
  const files = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const p = line.split("\t");
    if (p[0] === "F") {
      cur = { path: p[1], size: Number(p[2]), cwd: p[3] ? unjson(p[3].replace(/^"cwd":"|"$/g, "")) : null, msgs: [], titles: [], events: [], agy: [] };
      files.push(cur);
    } else if (!cur) {
      continue;
    } else if (p[0] === "M" && p.length >= 9) {
      const [input, write, read, output] = p[5].split(",").map(Number);
      const [h1 = 0, m5 = 0] = p[6] ? p[6].split(",").map(Number) : [];
      cur.msgs.push({ id: p[1], ts: p[2], model: p[3], entrypoint: p[4], input, write, read, output, h1, m5, sid: p[7], cwd: unjson(p[8]) });
    } else if (p[0] === "A" && p.length >= 5) {
      const [input, read, output] = p[4].split(",").map(Number);
      cur.agy.push({ step: Number(p[1]), ts: p[2], model: p[3], input, read, output });
    } else if ((p[0] === "C" || p[0] === "D") && p[1]) {
      if (!cur.cwd) cur.cwd = p[0] === "C" ? unjson(p[1]).replace(/\/[^/]+$/, "") : unjson(p[1]);
    } else if (p[0] === "T" && p[1] && p[2]) {
      cur.titles.push({ sid: p[1], title: unjson(p[2]) });
    } else if (line.startsWith('"timestamp"') || line.startsWith('"total_token_usage"')) {
      try {
        cur.events.push(JSON.parse(`{${line}}`));
      } catch {
        // a cut line says nothing
      }
    }
  }
  return files;
}

// The repo a folder belongs to when its path alone says it, else null.
export function projectFromPath(cwd) {
  if (!cwd) return "unknown";
  if (cwd.includes(HERDR_WORKTREES)) return cwd.split(HERDR_WORKTREES)[1].split("/")[0] || "unknown";
  if (cwd.includes("/.claude/worktrees/")) return cwd.split("/.claude/worktrees/")[0].split("/").pop() || "unknown";
  if (cwd.includes("/scratch-workspaces/")) return "scratch";
  return null;
}

export const emptyState = () => ({ v: 1, files: {}, projects: {}, rows: {}, sessions: {}, runs: {}, seen: {} });

// A transcript's session: its file name without the extension.
export const sessionOf = (path) => path.split("/").pop().replace(/\.jsonl$/, "");

export const RUN_BUCKET_MS = 300000;
// Tokens spent inside a run's worktree, by session and five minutes, so a run's attempts can be costed by their time.
function addRun(state, id, cwd, ts, context, output) {
  const folder = runFolder(cwd), at = Date.parse(ts);
  if (!folder || !id || !Number.isFinite(at)) return;
  const runs = state.runs ?? (state.runs = {}), key = `${folder}\t${id}`;
  const s = runs[key] ?? (runs[key] = { last: ts, spans: {} });
  if (at > Date.parse(s.last)) s.last = ts;
  const bucket = Math.floor(at / RUN_BUCKET_MS), span = s.spans[bucket] ?? (s.spans[bucket] = [0, 0]);
  span[0] += context;
  span[1] += output;
}

// The run folders the scanner holds tokens for.
export const runFolders = (state) => [...new Set(Object.keys(state.runs ?? {}).map((key) => key.split("\t")[0]))];

export const cutDay = (now = new Date()) => dayKey(new Date(now.getTime() - KEEP_DAYS * 86400000));

const surfaceOf = (entrypoint) => SURFACES[entrypoint || "cli"] ?? "automatic";
const shortId = (id) => id.slice(-ID_LENGTH);

// The ids already counted. A copy of a message keeps its time, so only its own day is asked: that day's set is
// built from the saved list when first needed, and `forget` drops the sets once a read ends.
export class SeenIds {
  constructor(state) {
    this.state = state;
    this.days = new Map();
  }

  // False when the id was counted before.
  add(day, id) {
    let ids = this.days.get(day);
    if (!ids) this.days.set(day, ids = new Set(this.state.seen[day]?.split(" ") ?? []));
    if (ids.has(id)) return false;
    ids.add(id);
    this.state.seen[day] = this.state.seen[day] ? `${this.state.seen[day]} ${id}` : id;
    return true;
  }

  forget() {
    this.days.clear();
  }
}

function addRow(state, key, add) {
  const row = state.rows[key] ?? (state.rows[key] = [0, 0, 0, 0, 0, 0, 0]);
  add.forEach((n, i) => { row[i] += n; });
}

// One Claude transcript's new messages. `kind` is "main" or "sub:<type>"; `project` names a folder.
export function addClaude(state, seen, file, { account, kind, project, cut }) {
  const f = state.files[file.path] ?? (state.files[file.path] = { size: 0, prev: "", last: null });
  for (const m of file.msgs) {
    if (!m.ts || m.model === "<synthetic>") continue;
    const at = Date.parse(m.ts) / 1000, gap = f.last != null ? at - f.last : 0;
    f.last = at;
    f.prev = m.id;
    const day = dayKey(new Date(m.ts)), id = shortId(m.id);
    if (day < cut || !seen.add(day, id)) continue;
    const surface = surfaceOf(m.entrypoint), own = surface === "automatic" ? "automatic" : kind;
    const where = project(m.cwd);
    const paused = own === "main" && gap > PAUSE_SECONDS && m.write > PAUSE_MIN_WRITE;
    addRow(state, [day, account, surface, where, own, m.model || "unknown"].join("\t"),
      [m.input, m.write, m.read, m.output, 1, paused ? m.write : 0, paused ? 1 : 0]);
    addRun(state, m.sid, m.cwd, m.ts, m.input + m.write + m.read, m.output);
    if (surface === "automatic") continue;
    const s = state.sessions[m.sid] ?? (state.sessions[m.sid] = { title: null, write: 0, output: 0 });
    Object.assign(s, { account, surface, project: where, last: m.ts });
    s.write += m.write;
    s.output += m.output;
  }
  for (const t of file.titles) {
    const s = state.sessions[t.sid] ?? (state.sessions[t.sid] = { title: null, write: 0, output: 0, last: null });
    s.title = t.title.slice(0, 120);
  }
  f.size = file.size;
}

// One Codex session's new events: each total, minus the one before it.
export function addCodex(state, file, { project, cut }) {
  const f = state.files[file.path] ?? (state.files[file.path] = { size: 0, cwd: null, total: {} });
  if (file.cwd) f.cwd = file.cwd;
  let ts = null;
  for (const e of file.events) {
    if (e.timestamp) {
      ts = e.timestamp;
      continue;
    }
    const total = e.total_token_usage, was = f.total ?? {};
    if (!total || !ts) continue;
    const delta = (k) => (total[k] ?? 0) - (was[k] ?? 0);
    const input = delta("input_tokens"), cached = delta("cached_input_tokens"), output = delta("output_tokens");
    // An event read again from the start of its block adds nothing and mustn't rewind the total.
    if (input <= 0 && cached <= 0 && output <= 0) continue;
    f.total = total;
    const day = dayKey(new Date(ts));
    if (day < cut) continue;
    const tokens = [Math.max(0, input - cached), 0, Math.max(0, cached), Math.max(0, output)];
    addRow(state, [day, "codex", "codex", project(f.cwd), "main", "codex"].join("\t"), [...tokens, 1, 0, 0]);
    addRun(state, sessionOf(file.path), f.cwd, ts, tokens[0] + tokens[2], tokens[3]);
  }
  f.size = file.size;
}

// One Antigravity transcript's new planner responses; input_tokens is uncached context growth.
export function addAgy(state, seen, file, { account = "agy", project, cut }) {
  const f = state.files[file.path] ?? (state.files[file.path] = { size: 0, cwd: null });
  if (file.cwd && !f.cwd) f.cwd = file.cwd;
  const sid = /\/brain\/([^/]+)\//.exec(file.path)?.[1] ?? sessionOf(file.path);
  const tag = sid.slice(-8);
  for (const m of file.agy ?? []) {
    if (!m.ts) continue;
    const day = dayKey(new Date(m.ts));
    if (day < cut || !seen.add(day, `a:${tag}:${m.step}`)) continue;
    const write = Math.max(0, m.input), read = Math.max(0, m.read), output = Math.max(0, m.output);
    const where = f.cwd ? project(f.cwd) : "Antigravity";
    addRow(state, [day, account, "agy", where, "main", m.model || "antigravity"].join("\t"), [0, write, read, output, 1, 0, 0]);
    addRun(state, sid, f.cwd, m.ts, write + read, output);
    const s = state.sessions[sid] ?? (state.sessions[sid] = { title: null, write: 0, output: 0 });
    Object.assign(s, { account, surface: "agy", project: where, last: m.ts });
    s.write += write;
    s.output += output;
  }
  f.size = file.size;
}

// Drops days, files and sessions older than the window; `listed` is every file still in it.
// Returns how many entries went.
export function prune(state, cut, listed) {
  let gone = 0;
  const drop = (obj, key) => {
    delete obj[key];
    gone += 1;
  };
  for (const key of Object.keys(state.rows)) if (key.slice(0, 10) < cut) drop(state.rows, key);
  for (const day of Object.keys(state.seen)) if (day < cut) drop(state.seen, day);
  // Without a listing (one failed), every file keeps its offset rather than being read again from the start.
  if (listed) for (const path of Object.keys(state.files)) if (!listed.has(path)) drop(state.files, path);
  for (const [id, s] of Object.entries(state.sessions)) if (!s.last || s.last.slice(0, 10) < cut) drop(state.sessions, id);
  for (const [key, s] of Object.entries(state.runs ?? {})) if (dayKey(new Date(s.last)) < cut) drop(state.runs, key);
  return gone;
}

// A span is under 30 bytes, so the report's runs stay under 250 KB; the report is read whole, up to 1 MiB.
const MAX_RUN_SPANS = 8000;
const COLUMNS = ["input", "write", "read", "output", "msgs", "pause_write", "pauses"];

// `folders`: the run folders worth reporting (still on disk or still in the queue); without it, all of them.
export function reportOf(state, updated, folders = null) {
  const rows = Object.entries(state.rows).map(([key, values]) => {
    const [day, account, surface, project, kind, model] = key.split("\t");
    return { day, account, surface, project, kind, model, ...Object.fromEntries(COLUMNS.map((c, i) => [c, values[i]])) };
  });
  const sessions = Object.entries(state.sessions).map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => b.write - a.write).slice(0, 200);
  // One entry per session that worked in a run's worktree, newest first; a span is [five-minute bucket, context tokens, output tokens].
  const runs = [];
  let room = MAX_RUN_SPANS;
  for (const [key, s] of Object.entries(state.runs ?? {}).sort((a, b) => (a[1].last < b[1].last ? 1 : -1))) {
    const [folder, id] = key.split("\t"), spans = Object.entries(s.spans).map(([bucket, [context, output]]) => [Number(bucket), context, output]);
    if ((folders && !folders.has(folder)) || spans.length > room) continue;
    room -= spans.length;
    runs.push({ id, folder, last: s.last, spans });
  }
  return { updated, rows, sessions, runs };
}

// The newest message of a transcript: model, context size, and how long its prompt cache lasts.
export function contextOf(file) {
  const m = file.msgs.at(-1);
  if (!m || m.model === "<synthetic>") return null;
  return {
    model: m.model, at: Math.round(Date.parse(m.ts) / 1000), context: m.input + m.write + m.read,
    ttl: m.h1 > 0 || !m.m5 ? 3600 : 300,
  };
}
