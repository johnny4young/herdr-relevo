// Ranking the quick replies: saved ones by how much you send them, then what you keep typing to your agents.

const DAY = 86400e3;
export const HALF_LIFE = 14 * DAY;
export const WINDOW = 90 * DAY;
export const MIN_USES = 3;
export const SHOWN = 5;

const SKIP = /^(\/|!|\[(pasted text|image))/i;
const decay = (age) => 0.5 ** (Math.max(0, age) / HALF_LIFE);

export const normal = (text) => text.trim().replace(/\s+/g, " ").toLowerCase().replace(/[.!?…]+$/, "");

// Prompts typed at least MIN_USES times in WINDOW, best first; `keep(project)` says which folders count.
export function historySuggestions(jsonl, now, keep) {
  const by = new Map();
  for (const line of jsonl.split("\n")) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const text = (d?.display ?? "").trim(), at = Number(d?.timestamp) || 0;
    if (text.length < 6 || text.length > 80 || text.includes("\n") || SKIP.test(text)) continue;
    if (now - at > WINDOW || at > now || !keep(d.project)) continue;
    const key = normal(text), e = by.get(key) ?? { text, at: 0, uses: 0, score: 0 };
    e.uses += 1;
    e.score += decay(now - at);
    if (at >= e.at) Object.assign(e, { at, text });
    by.set(key, e);
  }
  return [...by.values()].filter((e) => e.uses >= MIN_USES).sort((a, b) => b.score - a.score);
}

// usage: { [normal text]: { score, at } }, decayed when read and dropped once it is negligible.
export const usageScore = (u, now) => (u ? u.score * decay(now - u.at) : 0);

export function recordUse(usage, text, now) {
  const next = {};
  for (const [key, u] of Object.entries(usage ?? {})) {
    const score = usageScore(u, now);
    if (score >= 0.05) next[key] = { score, at: now };
  }
  const key = normal(text);
  next[key] = { score: (next[key]?.score ?? 0) + 1, at: now };
  return next;
}

// Saved replies by use, ties in their saved order, then suggestions until SHOWN in all.
export function rankReplies(saved, usage, suggestions, now) {
  const mine = saved.map((text, i) => ({ text, i, score: usageScore(usage?.[normal(text)], now) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ text }) => ({ text }));
  const have = new Set(saved.map(normal));
  const extra = suggestions.filter((s) => !have.has(normal(s.text)))
    .slice(0, Math.max(0, SHOWN - mine.length))
    .map(({ text, uses }) => ({ text, uses }));
  return [...mine, ...extra];
}
