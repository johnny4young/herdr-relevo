// A deep review's findings, from each reviewer's report: merged where they agree, as a GitHub draft review, and as
// the prompt of a run that fixes them. Pure, so tests feed it tasks.
import { LEVELS } from "./run-report.js";

const reportOf = (task) => [...(task.attempts ?? [])].reverse().find((a) => a.role === "reviewer" && a.report)?.report ?? null;
const who = (task) => task.reviewer?.label ?? task.reviewer?.address ?? "Reviewer";
const place = (where) => /^(.+?):(\d+)(?:-\d+)?$/.exec(String(where ?? "").trim());

// One entry per issue: the same file and line from two reviewers is one finding, at the higher level.
export function mergedFindings(tasks) {
  const out = [];
  for (const task of tasks) {
    for (const f of reportOf(task)?.findings ?? []) {
      const key = f.where ? f.where.replace(/\s+/g, "") : null;
      const same = key && out.find((x) => x.key === key);
      if (same) {
        if (!same.by.includes(who(task))) same.by.push(who(task));
        if (LEVELS.indexOf(f.level) < LEVELS.indexOf(same.level)) same.level = f.level;
        continue;
      }
      out.push({ key, level: f.level, where: f.where, issue: f.issue, fix: f.fix, by: [who(task)] });
    }
  }
  return out.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || b.by.length - a.by.length);
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

// What a fix run is asked to do: every blocker and major, then the minor ones as optional.
export function findingsPrompt(pr, tasks) {
  const findings = mergedFindings(tasks), must = findings.filter((f) => f.level !== "minor"), rest = findings.filter((f) => f.level === "minor");
  return [`Fix pull request #${pr.number} (${pr.url}) after a deep review by ${tasks.map(who).join(" and ")}.`,
    must.length ? `Fix each of these:\n${must.map(findingLine).join("\n")}` : "",
    rest.length ? `Optional, if they are cheap and safe:\n${rest.map(findingLine).join("\n")}` : "",
    "Keep the change to these findings, run the repository's tests, and say which finding each change answers."].filter(Boolean).join("\n\n");
}
