// Which account has the most room left: the fuller of its 5h and 7d windows is what stops it first.

export const marginOf = (q) => (q?.h5 || q?.d7 ? 100 - Math.max(q.h5?.pct ?? 0, q.d7?.pct ?? 0) : null);

// keys in preference order (the repo's account first, then the fallback order); no data ranks last.
export function mostMargin(keys, quotas) {
  const ranked = keys.map((key, i) => ({ key, i, margin: marginOf(quotas?.[key]) }))
    .sort((a, b) => (b.margin ?? -1) - (a.margin ?? -1) || a.i - b.i);
  return ranked[0] ?? null;
}
