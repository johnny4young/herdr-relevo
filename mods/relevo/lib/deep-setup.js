// Who a deep review asks, as config.js's DEEP_REVIEW says: an account ("repo" for the repo's own), a model and an
// effort each. Pure, so Settings checks a setup with the same rules Reviews launches it with.
import { providerOf } from "./providers.js";

export const DEFAULT_DEEP_REVIEW = [{ account: "repo", model: "opus", effort: "high" }, { account: "repo", model: "sonnet", effort: "high" }];
export const MAX_REVIEWERS = 6;

// `accounts` are { key, provider }; "repo" is a Claude account, as every repository context names one.
export const effortsFor = (key, accounts) => providerOf(accounts.find((a) => a.key === key)).efforts;

// Errors as { at, message }, `at` naming the row ("deepReview.1.effort").
export function checkDeepReview(list, accounts) {
  const errors = [], fail = (at, message) => errors.push({ at, message });
  if (!Array.isArray(list) || !list.length) return [{ at: "deepReview", message: "Deep review: add at least one reviewer" }];
  if (list.length > MAX_REVIEWERS) fail("deepReview", `Deep review: at most ${MAX_REVIEWERS} reviewers`);
  list.forEach((r, i) => {
    if (!["repo", ...accounts.map((a) => a.key)].includes(r.account)) fail(`deepReview.${i}.account`, `Deep review ${i + 1}: pick an account`);
    if (r.model && !/^[A-Za-z0-9._:[\]-]{1,80}$/.test(r.model)) fail(`deepReview.${i}.model`, `Deep review ${i + 1}: a model name like opus or sonnet`);
    const efforts = effortsFor(r.account, accounts);
    if (r.effort && !efforts.includes(r.effort)) fail(`deepReview.${i}.effort`, `Deep review ${i + 1}: effort is one of ${efforts.join(", ")}`);
  });
  return errors;
}

// "Team · opus high", or the model its CLI runs when none is named.
export const reviewerLabel = (accountLabel, r, defaultModel = "") => [accountLabel, [r.model || defaultModel, r.effort].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

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
