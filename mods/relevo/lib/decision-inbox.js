// Offline native preview only. All projects, people and evidence below are fictional.
// Reviewed means inspected locally, never an approval or operational action.
const STATUSES = new Set(["passed", "failed", "pending", "unknown", "skipped"]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const validResults = (results) => Array.isArray(results) && results.length > 0 &&
  results.every((result) => result && typeof result.label === "string" && result.label.trim() && STATUSES.has(result.status));

export function createDemoItems() {
  return [
    {
      id: "demo-exampleA-invite", project: "Example A · fictional", kind: "blocked", revision: "r1", reviewedRevision: null,
      goal: { id: "demo-exampleA-goal", title: "Invite the team without duplicates" },
      task: { id: "demo-exampleA-task", title: "Resolve duplicate invitations" }, owner: "Owner A · fictional",
      sessions: [{ id: "demo-exampleA-session-1", title: "Simulated implementation", owner: "Agent A · fictional", state: "blocked" },
        { id: "demo-exampleA-session-2", title: "Simulated review", owner: "Agent B · fictional", state: "waiting" }],
      priorityReason: "First: a failed test blocks the fictional goal.",
      decision: "If an invitation already exists, should it be reused or replaced with a new one?",
      decisionOptions: [{ id: "reuse", label: "Reuse the existing invitation" }, { id: "replace", label: "Replace it with a new one" }],
      nextActor: "Owner A · fictional product owner",
      nextStep: "Choose the duplicate policy; then the agent adapts the flow and checks it again.",
      recommendation: "Reuse the existing invitation to avoid duplicates. The failed test points to a defect, but does not decide the policy or authorize changes.",
      criteria: [{ label: "One invitation per person", status: "failed" }, { label: "Accessible message", status: "passed" }],
      evidence: { itemId: "demo-exampleA-invite", revision: "r1", summary: "Invented evidence: the second submission creates a duplicate.",
        checks: [{ label: "Duplicates", status: "failed", detail: "Synthetic result: two invitations are created." },
          { label: "Accessibility", status: "passed", detail: "Synthetic result: the notice has a label." }] },
    },
    {
      id: "demo-exampleB-export", project: "Example B · fictional", kind: "review", revision: "r1", reviewedRevision: null,
      goal: { id: "demo-exampleB-goal", title: "Export understandable reports" },
      task: { id: "demo-exampleB-task", title: "Review the empty report" }, owner: "Owner B · fictional",
      sessions: [{ id: "demo-exampleB-session-1", title: "Simulated preview", owner: "Agent C · fictional", state: "review" }],
      priorityReason: "Next: checks are missing before deciding on scope.",
      decision: "Should an empty report download with an explanation, or should downloading be blocked?",
      decisionOptions: [{ id: "explain", label: "Download with an explanation" }, { id: "prevent", label: "Block downloading until there is data" }],
      nextActor: "Owner B · fictional product owner",
      nextStep: "Choose the empty report behavior; then complete screenshot and keyboard validation.",
      recommendation: "Allow the download with a clear explanation. The pending screenshot and unverified keyboard support do not yet show that the flow works.",
      criteria: [{ label: "Explanation for empty report", status: "pending" }, { label: "Keyboard navigation", status: "unknown" }],
      evidence: { itemId: "demo-exampleB-export", revision: "r1", summary: "Invented, incomplete evidence: no screenshot or keyboard validation.",
        checks: [{ label: "Screenshot", status: "pending", detail: "Pending; no real image is attached." },
          { label: "Keyboard", status: "unknown", detail: "No result has been obtained." },
          { label: "Video", status: "skipped", detail: "Skipped in this fictional scenario; this does not mean passed." }] },
    },
    {
      id: "demo-exampleC-search", project: "Example C · fictional", kind: "ready", revision: "r1", reviewedRevision: null,
      goal: { id: "demo-exampleC-goal", title: "Find notes quickly" },
      task: { id: "demo-exampleC-task", title: "Review search with no results" }, owner: "Owner C · fictional",
      sessions: [{ id: "demo-exampleC-session-1", title: "Simulated tests", owner: "Agent D · fictional", state: "ready" }],
      priorityReason: "Finally: the simulated criteria pass; human review is still required.",
      decision: "Should the query remain visible when the search returns no results?",
      decisionOptions: [{ id: "keep-query", label: "Keep the query so it can be edited" }, { id: "clear-query", label: "Clear the query to start over" }],
      nextActor: "Owner C · fictional product owner",
      nextStep: "Confirm the expected query behavior; then the agent adjusts the sample if needed.",
      recommendation: "Keep the query so it can be corrected. Synthetic results support review, but are not a decision or approval.",
      criteria: [{ label: "Clear empty state", status: "passed" }, { label: "Recover the search", status: "passed" }],
      evidence: { itemId: "demo-exampleC-search", revision: "r1", summary: "Invented evidence: both simulated cases pass. This is not a real run.",
        checks: [{ label: "Empty state", status: "passed", detail: "Synthetic case: an explanation is shown." },
          { label: "New search", status: "passed", detail: "Synthetic case: the query can be changed." }] },
    },
  ];
}

export function evidenceCurrent(item) {
  return Boolean(item && typeof item.id === "string" && item.id && typeof item.revision === "string" && item.revision &&
    item.evidence && item.evidence.itemId === item.id && item.evidence.revision === item.revision &&
    validResults(item.evidence.checks) && validResults(item.criteria));
}

export function visibleItems(items, filter = "all") {
  return items.filter((item) => filter === "all" ||
    (filter === "reviewed" ? evidenceCurrent(item) && item.reviewedRevision === item.revision : item.kind === filter));
}

export function markReviewed(item) {
  return { ...item, reviewedRevision: evidenceCurrent(item) ? item.revision : null };
}

export function advanceRevision(item) {
  const next = /^r([0-9]+)$/.exec(item.revision);
  return { ...item, revision: next ? `r${Number(next[1]) + 1}` : `${item.revision}.next`, reviewedRevision: null };
}

export function refreshEvidence(item) {
  // This only rebinds fictional evidence; never runs tests or turns unknown results into passes.
  if (!item.evidence || item.evidence.itemId !== item.id) return { ...item, reviewedRevision: null };
  const refreshed = { ...item, evidence: { ...clone(item.evidence), itemId: item.id, revision: item.revision } };
  return { ...refreshed, reviewedRevision: evidenceCurrent(item) ? item.reviewedRevision : null };
}

export function updateItem(items, id, fn) {
  return items.map((item) => item.id === id ? fn(item) : item);
}
