// Who a deep review asks, as config.js's DEEP_REVIEW says: an account ("repo" for the repo's own), a model and an
// effort each. Pure, so Settings checks a setup with the same rules Reviews launches it with.
import { PROVIDERS } from "./providers.js";

export const DEFAULT_DEEP_REVIEW = [{ account: "repo", model: "opus", effort: "high" }, { account: "repo", model: "sonnet", effort: "high" }];
export const CLAUDE_EFFORTS = PROVIDERS.claude.efforts;
export const CODEX_EFFORTS = PROVIDERS.codex.efforts;
export const MAX_REVIEWERS = 6;

export const effortsFor = (account, codexKey) => (account === codexKey ? CODEX_EFFORTS : CLAUDE_EFFORTS);

// Errors as { at, message }, `at` naming the row ("deepReview.1.effort").
export function checkDeepReview(list, accountKeys, codexKey) {
  const errors = [], fail = (at, message) => errors.push({ at, message });
  if (!Array.isArray(list) || !list.length) return [{ at: "deepReview", message: "Deep review: add at least one reviewer" }];
  if (list.length > MAX_REVIEWERS) fail("deepReview", `Deep review: at most ${MAX_REVIEWERS} reviewers`);
  list.forEach((r, i) => {
    if (!["repo", codexKey, ...accountKeys].includes(r.account)) fail(`deepReview.${i}.account`, `Deep review ${i + 1}: pick an account`);
    if (r.model && !/^[A-Za-z0-9._:[\]-]{1,80}$/.test(r.model)) fail(`deepReview.${i}.model`, `Deep review ${i + 1}: a model name like opus or sonnet`);
    if (r.effort && !effortsFor(r.account, codexKey).includes(r.effort)) fail(`deepReview.${i}.effort`, `Deep review ${i + 1}: effort is one of ${effortsFor(r.account, codexKey).join(", ")}`);
  });
  return errors;
}

// The flags that set a reviewer's model and effort, after the run's own reviewer flags.
export const modelArgs = (r, codexKey, base) => PROVIDERS[r.account === codexKey ? "codex" : "claude"].modelArgs(r, base);

// "Team · opus high", or the Codex model the runs use when none is named.
export const reviewerLabel = (accountLabel, r, codexModel = "") => [accountLabel, [r.model || codexModel, r.effort].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

// The line under Deep review's ▾: "repo · opus high + Codex · high".
export const setupLine = (list, labelOf) => list.map((r) => reviewerLabel(r.account === "repo" ? "repo" : labelOf(r.account), r)).join(" + ");

// The models an account really used, newest first, from the token scan's report: what this machine can run.
export function recentModels(report, account) {
  const last = new Map();
  for (const row of report?.rows ?? []) {
    if (row.account !== account || !row.model || /^(unknown|<synthetic>|codex)$/.test(row.model)) continue;
    if (!last.has(row.model) || row.day > last.get(row.model)) last.set(row.model, row.day);
  }
  return [...last].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).map(([model, day]) => ({ model, day }));
}
