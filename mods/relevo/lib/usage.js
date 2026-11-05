// What the scanner's rows add up to; pure, so the tests can feed it fixtures.

export const RANGES = [["today", "Today", 1], ["7d", "7 days", 7], ["14d", "14 days", 14], ["30d", "30 days", 30]];

const SURFACES = [["desktop", "Desktop"], ["terminal", "Terminal"], ["automatic", "Automatic"], ["codex", "Codex"]];
const SHOWN_SUBAGENTS = 4;

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function lastDays(count, now = new Date()) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (count - 1 - i));
    return dayKey(d);
  });
}

function tally(rows, keyOf) {
  const out = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    const row = out.get(key) ?? { key, output: 0, write: 0 };
    row.output += r.output;
    row.write += r.write;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => b.write - a.write || b.output - a.output);
}

// Subagents by type, the few big ones by name and the rest together.
function kinds(rows) {
  const name = (r) => (r.kind === "main" ? "Main conversations" : r.kind === "automatic" ? "Automatic sessions" : r.kind.slice(4));
  const list = tally(rows, name), fixed = new Set(["Main conversations", "Automatic sessions"]);
  const subs = list.filter((k) => !fixed.has(k.key)), kept = subs.slice(0, SHOWN_SUBAGENTS), rest = subs.slice(SHOWN_SUBAGENTS);
  const other = rest.reduce((sum, k) => ({ key: "Other subagents", output: sum.output + k.output, write: sum.write + k.write }),
    { key: "Other subagents", output: 0, write: 0 });
  return [...list.filter((k) => fixed.has(k.key)), ...kept, ...(rest.length ? [other] : [])]
    .map((k) => ({ ...k, sub: !fixed.has(k.key) })).sort((a, b) => b.write - a.write);
}

export function summarize(report, days, account = null, now = new Date()) {
  const keys = lastDays(days, now), since = keys[0];
  const rows = (report?.rows ?? []).filter((r) => r.day >= since && (!account || r.account === account));
  const write = rows.reduce((n, r) => n + r.write, 0), output = rows.reduce((n, r) => n + r.output, 0);
  const surfaces = SURFACES.map(([key, label]) => {
    const own = rows.filter((r) => r.surface === key);
    const o = own.reduce((n, r) => n + r.output, 0);
    return { key, label, output: o, write: own.reduce((n, r) => n + r.write, 0), share: output ? o / output : 0 };
  }).filter((s) => s.output || s.write);
  const byDay = new Map(tally(rows, (r) => r.day).map((d) => [d.key, d]));
  return {
    total: { output, write, read: rows.reduce((n, r) => n + r.read, 0) },
    surfaces,
    days: keys.map((key) => byDay.get(key) ?? { key, output: 0, write: 0 }),
    projects: tally(rows, (r) => r.project),
    kinds: kinds(rows),
    paused: { write: rows.reduce((n, r) => n + r.pause_write, 0), count: rows.reduce((n, r) => n + r.pauses, 0) },
    sessions: (report?.sessions ?? []).filter((s) => s.last?.slice(0, 10) >= since && (!account || s.account === account)).slice(0, 6),
  };
}

// claude-opus-5-5 -> Opus 5.5; anything else keeps its name.
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/.exec(id ?? "");
  if (!m) return id ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// How long the prompt cache lasts from its last message, for an agent that isn't working: seconds, 0 when it's gone.
export const cacheLeft = (c, now = Date.now() / 1000) => Math.max(0, (c?.at ?? 0) + (c?.ttl ?? 0) - now);
