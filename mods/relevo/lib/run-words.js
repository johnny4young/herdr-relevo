// The words Runs show for stored states, roles and counts; the stored values never change.
export const STATES = { planned: "Planned", ready: "Ready", running: "In progress", needs_review: "Needs review", needs_you: "Needs me", accepted: "Completed", completed: "Completed", blocked: "Stuck", failed: "Stuck", cancelled: "Cancelled" };
export const taskState = (state) => STATES[state] ?? state ?? "Unknown";

export const ROLE = {
  executor: { pick: "Writes it", name: "Writer", noun: "writer", report: "Writer's report" },
  reviewer: { pick: "Reviews it", name: "Reviewer", noun: "reviewer", report: "Reviewer's report" },
};
export const role = (key) => ROLE[key === "reviewer" ? "reviewer" : "executor"];

// A reviewer's verdict on a result.
export const VERDICT = { completed: "Approved", changes_requested: "Asked for changes", blocked: STATES.blocked };
export const verdictLine = (status) => `Reviewer ${(VERDICT[status] ?? status ?? "").toLowerCase()}`;
export const reportState = (status, by = "executor") => (by === "reviewer" || status !== "completed" ? VERDICT[status] : null) ?? taskState(status);

export const count = (n, word) => {
  const k = n === "" || n == null ? NaN : Number(n);
  return `${Number.isFinite(k) ? k : "?"} ${k === 1 ? word : `${word}s`}`;
};
// Null before the first attempt starts, so nothing reads "attempt 0 of 2".
export const attemptLabel = (round, max, { capital = false } = {}) => Number(round) > 0 ? `${capital ? "Attempt" : "attempt"} ${Number(round)} of ${Number(max ?? 2)}` : null;
