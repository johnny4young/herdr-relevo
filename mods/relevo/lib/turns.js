// What one turn of an agent cost: the bytes its transcript and its subagents' gained between the turn's start
// and end, read as tokens. Pure, so the tests can feed it fixtures.

// A turn worth telling about: new context plus output.
export const HEAVY = 5e6;
const KEPT = 40;

// `wc -c` of the session file and its subagents' files.
export const SIZES = 'f=$1; d="${f%.jsonl}/subagents"; wc -c "$f" "$d"/*.jsonl 2>/dev/null';

// Ranges from each file's size at the start (0 for a subagent started during the turn) to its size now.
export function turnRanges(before, now) {
  const out = [];
  for (const [path, size] of now) {
    const from = before.get(path) ?? 0;
    if (size > from) out.push({ path, from, size, prev: "" });
  }
  return out;
}

// Adds up the messages the ranges hold from `since` on (a range starts at its 64 KiB block, so it can repeat
// older ones), each once; a subagent file that wasn't there at the start is a new one.
export function receiptOf(before, files, since = 0) {
  const seen = new Set(), r = { write: 0, output: 0, subs: 0, subWrite: 0, subOutput: 0 };
  const born = new Set();
  for (const f of files) {
    const sub = f.path.includes("/subagents/");
    for (const m of f.msgs) {
      if (!m.ts || m.model === "<synthetic>" || seen.has(m.id) || Date.parse(m.ts) / 1000 < since) continue;
      seen.add(m.id);
      r.write += m.write;
      r.output += m.output;
      if (!sub) continue;
      r.subWrite += m.write;
      r.subOutput += m.output;
      if (!before.has(f.path)) born.add(f.path);
    }
  }
  r.subs = born.size;
  return r;
}

export const heavy = (r) => r.write + r.output >= HEAVY;

// The newest receipts first, at most KEPT.
export const keepReceipts = (list, r) => [r, ...(list ?? [])].slice(0, KEPT);
