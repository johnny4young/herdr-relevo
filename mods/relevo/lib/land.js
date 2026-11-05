// Landing a PR from the Inbox: merge it, follow the workflows its merge starts, then clean up. Pure, so the
// tests can feed it fixtures.
import { ciOf } from "./github.js";

// How long a button waits for its confirming second click.
export const ARM_MS = 4000;
// After a merge, workflows take a moment to show up; past this, a repo without any has landed.
export const NO_RUNS_AFTER = 180;
const FLAGS = { SQUASH: "--squash", MERGE: "--merge", REBASE: "--rebase" };
const ALLOWED = { SQUASH: "squashMergeAllowed", MERGE: "mergeCommitAllowed", REBASE: "rebaseMergeAllowed" };
const RED = new Set(["FAILURE", "ERROR"]);
const PASSED = new Set(["success", "skipped", "neutral"]);

// The repo's default for you, else the first method it allows.
export function mergeFlag(repo) {
  const own = repo?.viewerDefaultMergeMethod;
  if (FLAGS[own] && repo?.[ALLOWED[own]] !== false) return FLAGS[own];
  const first = ["SQUASH", "MERGE", "REBASE"].find((m) => repo?.[ALLOWED[m]]);
  return FLAGS[first ?? "SQUASH"];
}

// What a PR of yours can do next, as GitHub sees it.
export function prMoves(pr) {
  const state = pr.mergeStateStatus, ci = ciOf(pr);
  const land = !pr.isDraft && (state === "CLEAN" || state === "HAS_HOOKS");
  return {
    land,
    auto: !land && !pr.isDraft && state === "BLOCKED" && Boolean(pr.repository?.autoMergeAllowed) && !pr.autoMergeRequest && !RED.has(ci),
    update: !pr.isDraft && state === "BEHIND",
    rerun: RED.has(ci) || ci === "CANCELLED",
    conflict: pr.mergeable === "CONFLICTING",
  };
}

// Where a merged PR's workflows stand: still running, one failed, or all done.
export function runsPhase(runs, mergedAt, now = Date.now() / 1000) {
  if (!runs.length) return { phase: now - mergedAt > NO_RUNS_AFTER ? "landed" : "ci", running: 0, total: 0, failed: null };
  const failed = runs.find((r) => r.status === "completed" && !PASSED.has(r.conclusion)) ?? null;
  const running = runs.filter((r) => r.status !== "completed").length;
  return { phase: failed ? "failed" : running ? "ci" : "landed", running, total: runs.length, failed };
}

export function landLine(entry) {
  switch (entry.phase) {
    case "queued": return "Merges as soon as GitHub allows it";
    case "merging": return "Merging…";
    case "ci": return entry.total ? `Merged · ${entry.running} of ${entry.total} workflows running` : "Merged · waiting for workflows";
    case "failed": return entry.failed ? `${entry.failed.name} failed after the merge` : entry.note ?? "Didn't land";
    default: return entry.note ? `Landed · ${entry.note}` : "Landed";
  }
}
