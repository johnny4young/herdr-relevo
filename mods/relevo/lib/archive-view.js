// Pure parser and search filter for archived Runs tasks stored in relevo-workflow/archive/*.jsonl.

export function parseArchiveLines(raw, limit = 200) {
  const byId = new Map();
  for (const line of String(raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const task = entry?.task;
    if (!task?.id) continue;
    const last = task.attempts?.at(-1);
    const repo = String(task.root ?? task.worktree?.base ?? "").split("/").filter(Boolean).pop() ?? "";
    byId.set(task.id, {
      id: task.id,
      title: task.title || task.id,
      state: task.state || "done",
      archivedAt: entry.archivedAt ?? task.createdAt ?? "",
      repo,
      branch: task.worktree?.branch ?? "",
      pr: task.worktree?.pr ?? task.pr?.url ?? null,
      attempts: task.attempts?.length ?? 0,
      summary: last?.executorReport?.summary ?? last?.reviewerReport?.summary ?? "",
    });
  }
  return [...byId.values()]
    .sort((a, b) => (Date.parse(b.archivedAt) || 0) - (Date.parse(a.archivedAt) || 0))
    .slice(0, limit);
}

export function filterArchive(entries, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return entries ?? [];
  const terms = q.split(/\s+/).filter(Boolean);
  return (entries ?? []).filter((e) => {
    const hay = `${e.title} ${e.repo} ${e.branch} ${e.state} ${e.summary}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}
