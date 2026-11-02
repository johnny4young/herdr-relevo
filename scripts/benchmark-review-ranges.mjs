// Synthetic CPU/RAM microbenchmark; NOT Herdr window, GPU, or end-to-end latency.
// node --expose-gc scripts/benchmark-review-ranges.mjs [current|reference] [comments=1000] [iterations=50]
import { performance } from "node:perf_hooks";
import { rangeRows, lineKey } from "../mods/relevo/lib/diff.js";

const [mode = "current", countText = "1000", iterationsText = "50"] = process.argv.slice(2);
const count = Number(countText), iterations = Number(iterationsText);
if (!["current", "reference"].includes(mode) || !Number.isSafeInteger(count) || count < 1 || count > 100000 || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10000) {
  throw new Error("Expected current|reference, 1..100000 comments, 1..10000 iterations");
}
// The original algorithm retained here solely as an equivalent-output comparison.
function reference(rows, comments) {
  const at = new Map();
  rows.forEach((r, i) => { if (r.number !== undefined) at.set(lineKey(r), i); });
  const marked = new Set();
  for (const c of comments) {
    const from = c.start ? at.get(c.start) : undefined, to = at.get(c.key);
    if (from === undefined || to === undefined) continue;
    for (let i = from; i <= to; i++) marked.add(i);
  }
  return marked;
}
const rows = Array.from({ length: 4000 }, (_, i) => ({ kind: "+", number: i + 1, text: "synthetic" }));
const comments = Array.from({ length: count }, (_, i) => ({ start: `+${1 + i % 100}`, key: `+${4000 - i % 100}` }));
const fn = mode === "current" ? rangeRows : reference;
for (let i = 0; i < 5; i++) fn(rows, comments);
global.gc?.();
const before = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
let marked;
for (let i = 0; i < iterations; i++) marked = fn(rows, comments);
const wallMs = performance.now() - started, used = process.cpuUsage(cpu), after = process.memoryUsage();
global.gc?.();
console.log(JSON.stringify({ mode, node: process.version, platform: `${process.platform}/${process.arch}`, rows: rows.length, comments: count, iterations,
  wallMs, cpuMs: (used.user + used.system) / 1000, rssBytes: after.rss, maxRssKiB: process.resourceUsage().maxRSS,
  allocatedHeapDeltaBytes: after.heapUsed - before.heapUsed, retainedHeapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed, marked: marked.size }));
