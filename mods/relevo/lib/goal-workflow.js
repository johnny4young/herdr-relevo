// Readiness describes what can be inspected, never approval or task completion.
export function reviewableWork(items, clones) {
  return items.filter((s) => !s.addressed && !s.draft && (s.kind === "local"
    ? s.item.kind === "diff" && Boolean(s.item.top)
    : s.kind === "pr" && Boolean(clones[s.pr.repo])));
}

export function scopeGoals(projection, id) {
  const selected = projection.groups.find((g) => g.goal.id === id);
  if (!selected) return { ...projection, scope: null, outsideCount: 0, outsideBlockers: 0 };
  const keys = new Set(selected.items.map((s) => s.key));
  const outside = projection.sources.filter((s) => !keys.has(s.key));
  return { ...projection, groups: [selected], unlinked: [], scope: selected.goal,
    outsideCount: outside.length, outsideBlockers: outside.filter((s) => s.blocked && !s.addressed).length };
}
