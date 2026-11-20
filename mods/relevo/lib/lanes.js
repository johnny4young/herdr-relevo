// Whose turn a pull request is, and the one reason it is in the list, in plain words.
import { ciOf, recent } from "./github.js";

export const ciRunning = (ci) => ci === "PENDING" || ci === "EXPECTED";
export const prName = (pr) => `${pr.repo.split("/")[1]} #${pr.number}`;
export const CI_WORDS = { SUCCESS: "CI passed", FAILURE: "CI failing", ERROR: "CI failing", CANCELLED: "CI cancelled", PENDING: "CI running", EXPECTED: "CI running" };

// seen: you ran its skill and nothing changed since; busy: its agent is on it; ready: only the merge is left.
export function prTurn(pr, { requested = false, seen = false, busy = false, ready = false } = {}) {
  if (seen || pr.isDraft) return "open";
  if (busy) return "flight";
  if (!recent(pr)) return "old";
  if (requested) return "me";
  const ci = ciOf(pr);
  if (ready || (pr.fresh && ci === "SUCCESS")) return "ready";
  if (pr.threads || (!pr.fresh && pr.reasons?.length)) return "me";
  return ciRunning(ci) ? "flight" : "open";
}

export function prReason(pr, { requested = false, ready = false } = {}) {
  const threads = pr.threads ? `${pr.threads} ${pr.threads === 1 ? "comment" : "comments"}` : null;
  if (requested) return [`${pr.author?.login ?? "someone"} ${pr.unasked ? "opened a PR" : "asks for your review"}`, threads].filter(Boolean).join(" · ");
  if (ready) return "CI passed, ready to merge";
  return [...(pr.reasons ?? []), threads].filter(Boolean).join(" · ") || CI_WORDS[ciOf(pr)] || "open";
}
