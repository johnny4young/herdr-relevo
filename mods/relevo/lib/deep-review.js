// A deep review's findings, from each reviewer's report: merged where they agree, as a GitHub draft review, and as
// the prompt of a run that fixes them. Pure, so tests feed it tasks.
import { LEVELS } from "./run-report.js";

const reportOf = (task) => [...(task.attempts ?? [])].reverse().find((a) => a.role === "reviewer" && a.report)?.report ?? null;
const who = (task) => task.reviewer?.label ?? task.reviewer?.address ?? "Reviewer";
const place = (where) => /^(.+?):(\d+)(?:-\d+)?$/.exec(String(where ?? "").trim());

const NEAR_LINES = 15;
const fileOf = (where) => String(where ?? "").trim().replace(/:\d+(?:-\d+)?$/, "");
const lineOf = (where) => Number(place(where)?.[2] ?? NaN);
const words = (text) => new Set(String(text ?? "").toLowerCase().match(/[a-z][a-z0-9_.]{3,}/g) ?? []);
const overlap = (a, b) => {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  return [...x].filter((w) => y.has(w)).length / Math.min(x.size, y.size);
};
// Two reviewers name one problem: the same file, near lines or much the same words.
const sameProblem = (a, b) => {
  if (!a.where || !b.where || fileOf(a.where) !== fileOf(b.where)) return false;
  const near = Math.abs(lineOf(a.where) - lineOf(b.where)) <= NEAR_LINES;
  return near || overlap(a.issue, b.issue) >= 0.5;
};

// One entry per problem: what two reviewers both found is one finding, at the higher level and with the longer words.
export function mergedFindings(tasks) {
  const out = [];
  for (const task of tasks) {
    for (const f of reportOf(task)?.findings ?? []) {
      const same = out.find((x) => !x.by.includes(who(task)) && sameProblem(x, f));
      if (same) {
        same.by.push(who(task));
        if (LEVELS.indexOf(f.level) < LEVELS.indexOf(same.level)) Object.assign(same, { level: f.level, where: f.where, issue: f.issue, fix: f.fix || same.fix });
        if (!same.proof && f.proof) same.proof = f.proof;
        continue;
      }
      out.push({ level: f.level, where: f.where, issue: f.issue, fix: f.fix, proof: f.proof ?? "", by: [who(task)] });
    }
  }
  return out.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || b.by.length - a.by.length);
}

const RANK = { needs_you: 0, blocked: 1, failed: 1, running: 2, needs_review: 2, ready: 2, planned: 3 };
// The reviewer whose row stands for the whole deep review: the one most in need of the person.
export const reviewLead = (reviews) => [...reviews].sort((a, b) => (RANK[a.state] ?? 4) - (RANK[b.state] ?? 4))[0] ?? null;
export const reviewTitle = (pr) => `Deep review · ${pr.url.split("/").slice(-3, -2)[0]} #${pr.number}`;

// What the person can do now, in one line.
export function reviewAdvice(reviews) {
  const waiting = verdicts(reviews).filter((v) => v.state === "working").map((v) => v.label);
  if (waiting.length) return `${waiting.join(" and ")} ${waiting.length === 1 ? "is" : "are"} still reviewing; ${waiting.length === 1 ? "its" : "their"} findings join when ${waiting.length === 1 ? "it reports" : "they report"}.`;
  const found = mergedFindings(reviews), must = found.filter((f) => f.level !== "minor").length, minor = found.length - must;
  if (must) return `${must} to fix: Fix with a run, or Post as draft review to leave them on the PR.${minor ? ` Also ${minor} minor ${minor === 1 ? "note" : "notes"}.` : ""}`;
  if (minor) return `Only minor notes (${minor}): Post as draft review to share them, or Done.`;
  return "No findings: Done closes the review.";
}

export const deepReviewDone = (tasks) => tasks.length > 0 && tasks.every((t) => reportOf(t) || ["accepted", "cancelled", "failed"].includes(t.state));

const findingLine = (f) => `- **${f.level}**${f.where ? ` \`${f.where}\`` : ""}: ${f.issue}${f.fix ? ` Fix: ${f.fix}` : ""} _(${f.by.join(", ")})_`;

// `inline`: findings with a file and line go as line comments; GitHub refuses lines outside the diff, so the caller
// retries without them.
export function draftReview(tasks, inline = true) {
  const findings = mergedFindings(tasks);
  const lines = inline ? findings.filter((f) => place(f.where)) : [];
  const summaries = tasks.map((t) => reportOf(t) && `**${who(t)}**: ${reportOf(t).summary ?? reportOf(t).status ?? "no summary"}`).filter(Boolean);
  const rest = findings.filter((f) => !lines.includes(f));
  const body = [`Deep review · ${tasks.map(who).join(" + ")}`, summaries.join("\n"),
    rest.length ? `Findings\n${rest.map(findingLine).join("\n")}` : findings.length ? "" : "No findings."].filter(Boolean).join("\n\n");
  const comments = lines.map((f) => {
    const [, path, line] = place(f.where);
    return { path, line: Number(line), side: "RIGHT", body: `**${f.level}**: ${f.issue}${f.fix ? `\n\nFix: ${f.fix}` : ""}\n\n_${f.by.join(", ")}_` };
  });
  return { body, comments };
}

// What a fix run is asked to do: every blocker and major, then the minor ones as optional. A task's prompt holds
// PROMPT_MAX characters, so long findings are cut and the optional ones go first.
const PROMPT_MAX = 3900;
export function findingsPrompt(pr, tasks) {
  const findings = mergedFindings(tasks), must = findings.filter((f) => f.level !== "minor"), rest = findings.filter((f) => f.level === "minor");
  const build = (cut, optional) => {
    const short = (f) => findingLine({ ...f, issue: f.issue.length > cut ? `${f.issue.slice(0, cut).trimEnd()}…` : f.issue,
      fix: f.fix && f.fix.length > cut ? `${f.fix.slice(0, cut).trimEnd()}…` : f.fix });
    return [`Fix pull request #${pr.number} (${pr.url}) after a deep review by ${tasks.map(who).join(" and ")}.`,
      must.length ? `Fix each of these:\n${must.map(short).join("\n")}` : "",
      optional && rest.length ? `Optional, if they are cheap and safe:\n${rest.map(short).join("\n")}` : "",
      "Keep the change to these findings, run the repository's tests, and say which finding each change answers."].filter(Boolean).join("\n\n");
  };
  for (const [cut, optional] of [[400, true], [200, true], [400, false], [200, false], [100, false]]) {
    const text = build(cut, optional);
    if (text.length <= PROMPT_MAX) return text;
  }
  return build(80, false).slice(0, PROMPT_MAX);
}

export const counted = (findings) => LEVELS.map((level) => [level, findings.filter((f) => f.level === level).length]).filter(([, n]) => n)
  .map(([level, n]) => `${n} ${level}`).join(", ");

// One line per reviewer: what it decided, in a word and its counts.
export function verdicts(tasks) {
  return tasks.map((task) => {
    const report = reportOf(task), findings = report?.findings ?? [];
    const state = !report ? "working" : report.status === "blocked" ? "unsure" : findings.some((f) => f.level !== "minor") || report.status === "changes_requested" ? "changes" : "approve";
    const line = state === "working" ? "reviewing…" : state === "unsure" ? `couldn't decide: ${report.summary ?? ""}`.trim()
      : state === "approve" ? (findings.length ? `ready to merge, ${counted(findings)}` : "ready to merge, no findings") : counted(findings) || "asks for changes";
    return { id: task.id, label: who(task), state, line, summary: report?.summary ?? "" };
  });
}

// What no reviewer could run or prove, once each.
export const unchecked = (tasks) => [...new Set(tasks.flatMap((t) => {
  const r = reportOf(t);
  return [...(r?.notRun ?? []).map((x) => `Not run: ${x}`), ...(r?.notProven ?? []).map((x) => `Not proven: ${x}`)];
}))];
