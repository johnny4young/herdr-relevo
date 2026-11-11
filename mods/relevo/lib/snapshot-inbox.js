// Persisted metadata only. Never turn a terminal state into a task, decision or approval.
const STATES = new Set(["blocked", "working", "idle", "done"]);
const RANK = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
export const SNAPSHOT_LABELS = { blocked: "Needs attention", working: "In progress", done: "Reported complete", idle: "Idle", unknown: "Unverified status" };
const text = (value, fallback = "Unnamed") => typeof value === "string" && value.trim()
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) : fallback;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function snapshotCards(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot?.mode !== "metadata-snapshot" || !date(snapshot.capturedAt) ||
      !Array.isArray(snapshot.spaces) || snapshot.spaces.length > 100) return null;
  const cards = [], ids = new Set();
  for (const space of snapshot.spaces) {
    if (typeof space?.sourceId !== "string" || !Array.isArray(space.tabs) || space.tabs.length > 100) return null;
    for (const tab of space.tabs) {
      if (typeof tab?.sourceId !== "string" || !Array.isArray(tab.terminals) || tab.terminals.length > 100) return null;
      const id = JSON.stringify([space.sourceId, tab.sourceId]);
      if (ids.has(id)) return null;
      ids.add(id);
      const sessions = tab.terminals.map((terminal) => ({
        id: text(terminal?.sourceId, "No ID"), title: text(terminal?.title, "Untitled terminal"),
        repo: text(terminal?.repoBasename, "Unknown folder"),
        status: STATES.has(terminal?.status) ? terminal.status : "unknown",
        statusAt: terminal?.statusAt ?? null, agentApp: text(terminal?.agentApp, "Unknown agent"),
      }));
      const status = sessions.map((session) => session.status).sort((a, b) => RANK[a] - RANK[b])[0] ?? "unknown";
      cards.push({ id, projectId: space.sourceId, project: text(space.title), title: text(tab.title),
        sourceTab: tab.sourceId, repo: text(space.repoBasename, "Unknown folder"), status,
        sessions, goal: "Not set", responsible: "Not set", criteria: "No evidence imported",
        capturedAt: snapshot.capturedAt });
      if (cards.length > 500) return null;
    }
  }
  return cards.sort((a, b) => RANK[a.status] - RANK[b.status]);
}

export function filterSnapshot(cards, filter) {
  return cards.filter((card) => filter === "all" || (filter === "resting" ? ["done", "idle"].includes(card.status) : card.status === filter));
}

export function snapshotTime(value) {
  if (typeof value === "number") value = Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
  return date(value) ? new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "Unavailable";
}
