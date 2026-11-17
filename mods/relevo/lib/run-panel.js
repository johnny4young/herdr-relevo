// What the Runs panel says about a run and its tasks; pure, so the tests can run it under Node.
import { count, role, verdictLine, attemptLabel } from "./run-words.js";
import { lastReview, workflowCheckSummary } from "./workflow-navigation.js";
import { reportNotes } from "./run-report.js";

const DONE = ["accepted", "cancelled"], STUCK = ["blocked", "failed"];
const TIMES = ["", "once", "twice"], ORDINAL = ["", "1st", "2nd", "3rd"];
const times = (n) => TIMES[n] ?? `${n} times`;
const ordinal = (n) => ORDINAL[n] ?? `${n}th`;
const firstLine = (s, limit = 80) => {
  const line = String(s ?? "").trim().split("\n")[0];
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const live = (task) => [...(task.attempts ?? [])].reverse().find((attempt) => attempt.state === "running");
const rejections = (task) => (task.attempts ?? []).filter((attempt) => attempt.role === "reviewer"
  && ["changes_requested", "blocked"].includes(attempt.report?.status)).length;
const attemptsLeft = (task) => (task.round ?? 0) < (task.maxRounds ?? 2);
const person = (task, key) => task[key]?.label ?? task[key]?.address ?? role(key).name;
// What a queued task waits for, as the coordinator last saw it: a slot, its checkout or its agent.
const waitsFor = (task) => (!task.paused && ["ready", "needs_review"].includes(task.state) && task.waitsFor
  ? firstLine(task.waitsFor.replace(/\.$/, "").replace(/^W/, "w"), 60) : null);

// Whose turn a task is: me, stuck, flight, open (not started) or done.
export function taskTurn(task) {
  if (task.state === "needs_you") return "me";
  if (STUCK.includes(task.state)) return "stuck";
  if (DONE.includes(task.state)) return "done";
  return task.state === "planned" || (task.state === "ready" && !task.attempts?.length) ? "open" : "flight";
}

export const TASK_GROUPS = ["me", "stuck", "flight"];
export const emptyBucket = () => ({ all: [], me: [], stuck: [], flight: [], open: [], done: [] });

// Every run's tasks by turn, in one pass: goal id -> bucket.
export function bucketTasks(tasks) {
  const buckets = new Map();
  for (const task of tasks) {
    if (!buckets.has(task.goalId)) buckets.set(task.goalId, emptyBucket());
    const bucket = buckets.get(task.goalId);
    bucket.all.push(task); bucket[taskTurn(task)].push(task);
  }
  return buckets;
}
export const runBucket = (tasks, goalId) => bucketTasks(tasks).get(goalId) ?? emptyBucket();

// What asking for changes does: another attempt, or a follow-up task when none is left.
export function changesPlan(task) {
  const spent = !attemptsLeft(task);
  return { spent, send: spent ? "Prepare follow-up" : "Send feedback",
    hint: spent ? "No attempts left: this prepares a follow-up task for you to start." : `Starts ${attemptLabel((task.round ?? 0) + 1, task.maxRounds)}: write, then review.` };
}

// "9 tasks:" and its parts; `hot` marks the ones that wait on the person.
export function runSummary(bucket) {
  const c = Object.fromEntries(Object.entries(bucket).map(([turn, list]) => [turn, list.length]));
  return { head: `${count(c.all, "task")}:`, parts: [
    [c.me, `${c.me} ${c.me === 1 ? "needs" : "need"} you`, true], [c.stuck, `${c.stuck} stuck`, true], [c.flight, `${c.flight} in flight`],
    [c.open, `${c.open} not started`], [c.done, `${c.done} done`],
  ].filter(([n]) => n > 0).map(([, text, hot = false]) => ({ text, hot })) };
}

const stuckWhy = (task) => (rejections(task) ? `the reviewer rejected it ${times(rejections(task))}` : firstLine(task.error) || `"${task.title}" could not finish`);

// The short state at a task row.
export function taskReason(task) {
  const turn = taskTurn(task);
  if (turn === "me") {
    const status = lastReview(task)?.report?.status;
    if (!status) return "ready for your review";
    if (status !== "completed") return verdictLine(status).toLowerCase();
    return task.round > 1 ? `approved, ${ordinal(task.round)} attempt` : "reviewer approved";
  }
  if (turn === "stuck") {
    const why = rejections(task) ? `rejected ${times(rejections(task))}` : firstLine(task.error, 60) || "could not finish";
    return attemptsLeft(task) ? why : `${why}, no attempts left`;
  }
  if (turn === "flight") {
    const attempt = live(task);
    if (attempt) return `${person(task, attempt.role === "reviewer" ? "reviewer" : "executor")} is ${attempt.role === "reviewer" ? "reviewing" : "writing"} it`;
    return task.paused ? "paused" : waitsFor(task) ?? (task.state === "needs_review" ? "waits for its reviewer" : "waits for its agent");
  }
  return turn === "open" ? waitsFor(task) ?? "not started" : task.state;
}

// When a task last moved, in seconds, or null.
export function taskAt(task) {
  const at = Date.parse(task.attempts?.at(-1)?.at ?? lastReview(task)?.at ?? "");
  return Number.isFinite(at) ? at / 1000 : null;
}

// The reviewer's finding on a stuck task, one line each; the task's own error when no review was recorded.
// Why a task is stuck, short: the newest report's first line, then its findings as level, file and issue.
const clip = (s, n) => { const one = String(s ?? "").trim().split("\n")[0]; return one.length > n ? `${one.slice(0, n - 1)}…` : one; };
export function stuckFindings(task) {
  const report = [...(task.attempts ?? [])].reverse().find((a) => a.report)?.report ?? lastReview(task)?.report;
  const lines = [clip(report?.summary, 160), ...(report?.findings ?? []).map((f) => clip(`[${f.level}] ${f.where ? `${String(f.where).split("/").pop()}: ` : ""}${f.issue}`, 120))].filter(Boolean);
  return lines.length ? lines : [clip(task.error, 160) || "No finding was recorded."];
}

// A stuck task with nothing running and no attempt or review left: only a new task moves it on.
export function followUpAvailable(task) {
  const latest = task.attempts?.at(-1);
  if (!STUCK.includes(task.state) || latest?.state === "running" || ["uncertain", "sending"].includes(latest?.delivery)) return false;
  return !attemptsLeft(task) || (task.attempts ?? []).filter((attempt) => attempt.role === "reviewer").length >= (task.maxRounds ?? 2) + 1;
}

// A run row from its bucket of tasks: its group, lane glyph, what it is doing or wants, and its one action.
export function runRow(goal, bucket, { engine = null, error = null, decision = false, reviewCount = 0, launch = null } = {}) {
  const open = { kind: "open", label: "Open" };
  // Between Start and its first task: what the launch waits on, and the yes to a trust question.
  if (launch?.goalId === goal.id && !bucket.all.length) return launch.trust
    ? { group: "me", turn: "me", hot: true, now: launch.words, action: { kind: "trust", label: "Trust and continue", address: launch.trust.address } }
    : { group: "flight", turn: "flight", now: launch.words, action: open };
  if (error) return { group: "me", turn: "stuck", now: "status unavailable", hot: true, action: open };
  const c = { me: bucket.me.length, open: bucket.open.length };
  if (c.me) return { group: "me", turn: "me", hot: true, now: `${count(c.me, "result")} ${c.me === 1 ? "waits" : "wait"} for your review`,
    action: { kind: "review", label: `Review ${c.me}` } };
  if (bucket.stuck.length) {
    const task = bucket.stuck[0];
    return { group: "me", turn: "stuck", hot: true, now: `stuck: ${stuckWhy(task)}`, action: { kind: "why", label: "See why", taskId: task.id } };
  }
  if (bucket.flight.length) {
    const flying = bucket.flight, task = flying.find(live) ?? flying[0], attempt = live(task);
    if (attempt) return { group: "flight", turn: "flight", now: `an agent is ${attempt.role === "reviewer" ? "reviewing" : "writing"} "${task.title}"`, action: open };
    const paused = !engine?.enabled || flying.every((item) => item.paused);
    return { group: "flight", turn: paused ? "open" : "flight", action: open,
      now: paused ? `paused: "${task.title}" waits to resume` : `"${task.title}" ${task.state === "needs_review" ? "waits for its reviewer" : "waits for its agent"}` };
  }
  if (c.open) return { group: "open", turn: "open", now: c.open === 1 ? "1 task planned, not started" : `${c.open} tasks planned, not started`, action: open };
  if (bucket.done.some((task) => task.state === "accepted")) return { group: "ready", turn: "ready", now: "finished, everything accepted", action: open };
  if (bucket.done.length) return { group: "ready", turn: "old", now: bucket.done.length === 1 ? "cancelled" : "all its tasks cancelled", action: open };
  if (decision && goal.decision?.trim()) return { group: "me", turn: "me", hot: true, now: `your decision: ${firstLine(goal.decision, 120)}`, action: { kind: "decide", label: "Decide" } };
  if (goal.state === "completed") return { group: "ready", turn: "old", now: "closed", action: open };
  if (reviewCount) return { group: "open", turn: "open", now: `${count(reviewCount, "linked change")} to review`, action: { kind: "changes", label: "Review" } };
  return { group: "open", turn: "open", now: "needs a plan before agents start", action: { kind: "plan", label: "Plan" } };
}

export const RUN_GROUPS = [["me", "Needs me"], ["flight", "In flight"], ["ready", "Ready"], ["open", "Not started"]];

const MERGED = ["ci", "landed"];
export const isMerged = (entry) => Boolean(entry) && (MERGED.includes(entry.phase) || Boolean(entry.mergedAt));
const prNumber = (url) => `#${/\/pull\/(\d+)/.exec(url)?.[1] ?? "?"}`;

// What reached GitHub: the run's linked PRs and the draft PRs of its accepted worktree tasks.
// `items` are its open linked sources, `merged` the URLs known to have merged.
export function shippedPRs(goal, bucket, items = [], merged = {}) {
  const state = new Map();
  for (const task of bucket.done) if (task.state === "accepted" && task.worktree?.pr) state.set(task.worktree.pr, "opened");
  for (const source of items) if (source.kind === "pr") state.set(source.pr.url, source.draft ? "draft" : "open");
  for (const key of goal.sources ?? []) if (key.startsWith("pr:") && merged[key.slice(3)]) state.set(key.slice(3), "merged");
  for (const url of state.keys()) if (merged[url]) state.set(url, "merged");
  return state;
}

export function runShipped(goal, bucket, items = [], merged = {}) {
  const state = shippedPRs(goal, bucket, items, merged);
  const of = (kind) => [...state].filter(([, value]) => value === kind).map(([url]) => prNumber(url));
  const parts = [["merged", (n) => `${count(n, "pull request")} merged`], ["open", (n) => `${count(n, "pull request")} open`],
    ["draft", (n) => count(n, "draft pull request")], ["opened", (n) => `${count(n, "pull request")} opened`]]
    .map(([kind, words]) => [of(kind), words]).filter(([list]) => list.length).map(([list, words]) => `${words(list.length)}: ${list.join(", ")}`);
  return { any: parts.length > 0, text: parts.join(" · ") || "nothing yet" };
}

// Who did what on a task, in order; the last row is the person's.
export function taskLegs(task) {
  const attempts = task.attempts ?? [];
  const at = (key) => attempts.findLastIndex((attempt) => attempt.role === key);
  const writerAt = at("executor"), reviewerAt = at("reviewer"), writer = attempts[writerAt], checks = workflowCheckSummary(task);
  const reviewer = reviewerAt > writerAt ? attempts[reviewerAt] : null, verdict = reviewer?.report;
  const findings = verdict?.findings?.length ?? 0;
  const legs = [
    ...(task.pr ? [] : [{ id: "writer", who: person(task, "executor"), at: writer?.at ?? null,
      state: !writer ? "wait" : !writer.report ? "run" : writer.report.status === "completed" ? "ok" : "bad",
      what: !writer ? "writes it" : !writer.report ? "is writing it" : writer.report.status === "completed" ? `wrote it${task.worktree ? " in its own worktree" : ""}` : "could not finish it" }]),
    { id: "tests", who: "Tests", at: null, state: checks.tone === "normal" ? "ok" : checks.tone === "failure" ? "bad" : "wait", what: checks.label.toLowerCase() },
    { id: "reviewer", who: person(task, "reviewer"), at: reviewer?.at ?? null,
      state: !reviewer ? "wait" : !verdict ? "run" : verdict.status === "completed" ? "ok" : "bad",
      what: !reviewer ? "reviews it" : !verdict ? "is reviewing it" : verdict.status === "completed" ? `reviewed it: approved, ${findings ? count(findings, "note") : "no findings"}`
        : verdict.status === "blocked" ? "reviewed it: stuck" : `reviewed it: asked for changes, ${count(findings, "finding")}` },
  ];
  const turn = taskTurn(task);
  legs.push({ id: "you", who: "You", at: null, now: turn === "me",
    state: turn === "me" || turn === "stuck" ? "you" : task.state === "accepted" ? "ok" : "wait",
    what: turn === "me" ? "accept it, or say what to change" : turn === "stuck" ? "decide what happens next"
      : task.state === "accepted" ? "accepted it" : task.state === "cancelled" ? "cancelled it" : "decide after the review" });
  return legs;
}

// The writer's own words about the result, cut to a few lines.
export function taskSummary(task, limit = 260) {
  const summary = [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === "executor" && attempt.report?.summary)?.report.summary.trim() ?? "";
  return summary.length > limit ? `${summary.slice(0, limit - 1)}…` : summary;
}

const plain = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// What the person weighs before accepting: the findings of the review that saw the latest writing, then what nobody
// checked, once each. A writer's note about a check the coordinator then ran and passed is no longer true, so it goes.
export function taskNotes(task) {
  const attempts = task.attempts ?? [], wrote = attempts.findLastIndex((a) => a.role === "executor");
  const reviewed = attempts.findLastIndex((a) => a.role === "reviewer" && a.report);
  const review = reviewed > wrote ? attempts[reviewed].report : null, writer = wrote >= 0 ? attempts[wrote].report : null;
  const passed = (task.checksResult ?? []).filter((c) => c.code === 0).map((c) => plain((c.argv ?? []).join(" "))).filter(Boolean);
  const seen = new Set(), once = (s) => { const k = plain(s); if (!k || seen.has(k)) return false; seen.add(k); return true; };
  const writerNotes = (writer?.notProven ?? []).filter((s) => !passed.some((cmd) => plain(s).includes(cmd)));
  return { findings: review?.findings ?? [], unchecked: [...(review?.notRun ?? []), ...(review?.notProven ?? []), ...writerNotes].filter(once) };
}

// The same, one line each, for a follow-up's prompt and the places that need text.
export function taskCaveats(task) {
  const notes = taskNotes(task);
  return [...reportNotes({ findings: notes.findings }), ...notes.unchecked];
}

// Agents Relevo opened for a run whose part is over: a deep review's reviewer once it reported, and both agents of a
// run in its own worktree once it is accepted or cancelled. Agents a run borrowed from your own sessions stay.
export function finishedAgents(tasks) {
  return tasks.flatMap((task) => {
    const over = ["accepted", "cancelled"].includes(task.state);
    if (task.pr) return over || (task.attempts ?? []).some((a) => a.role === "reviewer" && a.report) ? [task.reviewer?.address] : [];
    return task.worktree && over ? [task.executor?.address, task.reviewer?.address] : [];
  }).filter(Boolean);
}
