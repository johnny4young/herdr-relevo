// Whose turn a pull request is, and the one reason it is in the list, in plain words.
import { ciOf, recent } from "./github.js";

export const CI_WORDS = { SUCCESS: "CI passed", FAILURE: "CI failing", ERROR: "CI failing", CANCELLED: "CI cancelled", PENDING: "CI running", EXPECTED: "CI running" };
const quiet = (reason) => reason === "draft" || reason === "new" || reason.startsWith("new,");

// seen: you ran its skill and nothing changed since; busy: its agent is on it; ready: only the merge is left.
export function prTurn(pr, { requested = false, seen = false, busy = false, ready = false } = {}) {
  if (seen || pr.isDraft) return "open";
  if (busy) return "flight";
  if (!recent(pr)) return "old";
  if (requested) return "me";
  if (ready || pr.reasons?.includes("new, CI passed")) return "ready";
  if (pr.threads || pr.reasons?.some((r) => !quiet(r))) return "me";
  const ci = ciOf(pr);
  return ci === "PENDING" || ci === "EXPECTED" ? "flight" : "open";
}

export function prReason(pr, { requested = false, ready = false } = {}) {
  const threads = pr.threads ? `${pr.threads} ${pr.threads === 1 ? "comment" : "comments"}` : null;
  if (requested) return [`${pr.author?.login ?? "someone"} asks for your review`, threads].filter(Boolean).join(" · ");
  if (ready) return "CI passed, ready to merge";
  return [...(pr.reasons ?? []), threads].filter(Boolean).join(" · ") || CI_WORDS[ciOf(pr)] || "open";
}
