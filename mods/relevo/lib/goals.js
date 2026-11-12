// Goal records describe human intent. Terminal state never grants review or approval.
export const emptyGoals = () => ({ version: 1, revision: 0, goals: [], history: [] });
const bounded = (s, max = 2000) => typeof s === "string" && s.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
export const webLink = (s) => typeof s === "string" && /^https:\/\/[^\s/@]+(?:[/?#][^\s]*)?$/.test(s);
export const sourceKey = (kind, id) => `${kind}:${id}`;
export const GOAL_STATES = { active: "In progress", paused: "Paused", completed: "Closed by you" };
export const STEP_STATES = { todo: "Pending", working: "In progress", review: "Needs review", done: "Validated" };
export const goalState = (goal) => goal.state ?? "active";

export function validateGoals(doc) {
  if (!doc || doc.version !== 1 || !Number.isSafeInteger(doc.revision) || doc.revision < 0 ||
      !Array.isArray(doc.goals) || doc.goals.length > 200 || !Array.isArray(doc.history) || doc.history.length > 1000) throw Error("Invalid or full goal file");
  const ids = new Set(), sources = new Set();
  for (const g of doc.goals) {
    if (!bounded(g.id, 100) || !g.id || ids.has(g.id) || !bounded(g.title, 240) || !g.title.trim() ||
        ![0, 1, 2, 3].includes(g.priority) || !Number.isSafeInteger(g.version) || g.version < 1 ||
        !["owner", "lead", "decision", "recommendation", "criteria"].every((k) => bounded(g[k])) ||
        !Array.isArray(g.sources) || g.sources.length > 100 || !Array.isArray(g.evidence) || g.evidence.length > 20 ||
        !Array.isArray(g.decisions) || g.decisions.length > 100) throw Error("Invalid goal");
    if (g.decisionLink != null && (!bounded(g.decisionLink.taskId, 100) || !g.decisionLink.taskId ||
        !bounded(g.decisionLink.question) || !g.decisionLink.question.trim())) throw Error("Invalid decision link");
    ids.add(g.id);
    if (!Object.hasOwn(GOAL_STATES, goalState(g)) || !Array.isArray(g.steps ?? []) || (g.steps?.length ?? 0) > 20) throw Error("Invalid goal plan");
    const steps = new Set();
    for (const step of g.steps ?? []) {
      if (!bounded(step.id, 100) || !step.id || steps.has(step.id) || !bounded(step.title, 240) || !step.title.trim() ||
          !Object.hasOwn(STEP_STATES, step.state)) throw Error("Invalid goal step");
      steps.add(step.id);
    }
    for (const source of g.sources) {
      if (!bounded(source, 600) || !/^(pr|local):.+/.test(source) || sources.has(source)) throw Error("Duplicate or invalid work item");
      sources.add(source);
    }
    for (const e of g.evidence) {
      if (!g.sources.includes(e.source) || !/^[a-f0-9]{40,64}$/.test(e.revision) || !["screenshot", "video", "report"].includes(e.kind) ||
          !webLink(e.url) || !bounded(e.label, 240)) throw Error("Invalid evidence: requires a linked PR, exact revision and HTTPS link");
    }
    for (const d of g.decisions) {
      if (!bounded(d.text) || (d.resolved !== undefined && typeof d.resolved !== "boolean") || !bounded(d.at, 100) || !Array.isArray(d.revisions) ||
          !d.revisions.every((r) => bounded(r.source, 600) && bounded(r.revision, 100))) throw Error("Invalid decision");
    }
  }
  const bytes = [...JSON.stringify(doc)].reduce((n, c) => { const p = c.codePointAt(0); return n + (p <= 0x7f ? 1 : p <= 0x7ff ? 2 : p <= 0xffff ? 3 : 4); }, 0);
  if (bytes > 700000) throw Error("Goal file is full; archive history before continuing");
  return doc;
}

export function parseGoals(raw) { return raw === null ? emptyGoals() : validateGoals(JSON.parse(raw)); }

export function saveGoal(doc, goal, expectedVersion, at = new Date().toISOString(), { close = false } = {}) {
  validateGoals(doc);
  const old = doc.goals.find((g) => g.id === goal.id);
  if ((old?.version ?? 0) !== expectedVersion) throw Error("This goal changed. Close and reopen it before saving.");
  if (!close && goalState(goal) === "completed" && (goal.decision.trim() || (goal.steps ?? []).some((s) => s.state !== "done"))) {
    throw Error("Resolve the pending decision and validate the plan steps before closing.");
  }
  const next = { ...goal, version: expectedVersion + 1 };
  const result = { ...doc, revision: doc.revision + 1,
    goals: old ? doc.goals.map((g) => g.id === next.id ? next : g) : [...doc.goals, next],
    history: [...doc.history, { goal: next.id, version: next.version, at, action: close ? "closed" : old ? "updated" : "created", state: goalState(next) }] };
  return validateGoals(result);
}

// Closing gives up on open work: a pending question is kept as unresolved, steps keep their state.
export function closeGoal(goal, at = new Date().toISOString()) {
  const question = goal.decision.trim();
  return { ...goal, state: "completed", decision: "", decisionLink: null,
    decisions: question ? [...goal.decisions, { text: question, resolved: false, at, revisions: [] }].slice(-100) : goal.decisions };
}

export function newGoal(id, title = "", sources = []) {
  return { id, title, version: 0, state: "active", steps: [], priority: 2, owner: "", lead: "", decision: "", recommendation: "", criteria: "", sources, evidence: [], decisions: [] };
}

export function groupSources(doc, sources) {
  const unique = [...new Map(sources.map((s) => [s.key, s])).values()];
  const linked = new Set();
  const groups = doc.goals.map((goal) => {
    const items = unique.filter((s) => goal.sources.includes(s.key));
    items.forEach((s) => linked.add(s.key));
    const urgency = items.some((s) => s.blocked && !s.addressed) ? 0 : goal.decision ? 1 : goalState(goal) === "active" ? 2 : goalState(goal) === "paused" ? 3 : 4;
    return { goal, items, urgency };
  }).sort((a, b) => a.urgency - b.urgency || a.goal.priority - b.goal.priority || a.goal.id.localeCompare(b.goal.id));
  return { groups, unlinked: unique.filter((s) => !linked.has(s.key)) };
}

export function evidenceState(evidence, sources, fresh) {
  const source = sources.find((s) => s.key === evidence.source);
  if (!fresh || !source?.revision) return "Unverified";
  return source.revision === evidence.revision ? "Matches the latest PR read" : "Outdated: commit changed";
}
