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
// Each deep review names the commit it read, so two reviews of one PR tell apart.
export const reviewTitle = (pr) => `Deep review · ${pr.url.split("/").slice(-3, -2)[0]} #${pr.number}${pr.head ? ` · ${pr.head.slice(0, 7)}` : ""}`;

// What the person can do now, in one line.
export function reviewAdvice(reviews) {
  const waiting = verdicts(reviews).filter((v) => v.state === "working").map((v) => v.label);
  if (waiting.length) return `${waiting.join(" and ")} ${waiting.length === 1 ? "is" : "are"} still reviewing; ${waiting.length === 1 ? "its" : "their"} findings join when ${waiting.length === 1 ? "it reports" : "they report"}.`;
  const found = mergedFindings(reviews), must = found.filter((f) => f.level !== "minor").length, minor = found.length - must;
  if (must) return `${must} to fix: Fix with a run, or Post as draft review to leave them on the PR.${minor ? ` Also ${minor} minor ${minor === 1 ? "note" : "notes"}.` : ""}`;
  if (minor) return `Only minor notes (${minor}): Post as draft review to share them, or Done.`;
  return "No findings: Done closes the review.";
}

// A fix run's report as its verdicts: each finding Fixed, a False positive, Won't fix or Needs your call, with why.
// "Not fixed" is how earlier runs said Won't fix.
export function fixChecklist(task) {
  const report = [...(task.attempts ?? [])].reverse().find((a) => a.role === "executor" && a.report)?.report;
  const items = (report?.details ?? []).map((line) => /^(Fixed|False positive|Won't fix|Not fixed|Needs your call):\s*(.+)$/i.exec(line.trim())).filter(Boolean)
    .map(([, mark, text]) => ({ verdict: VERDICTS.find((v) => v.toLowerCase() === mark.toLowerCase()) ?? "Won't fix", text }));
  if (!items.length) return null;
  const groups = VERDICTS.map((verdict) => ({ verdict, items: items.filter((i) => i.verdict === verdict) })).filter((g) => g.items.length);
  return { groups, head: groups.map((g) => `${g.items.length} ${g.verdict.toLowerCase()}`).join(" · ") };
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

// What a fix run is asked to do: a verdict on every finding, as /code-review-pr-fix gives one. A task's prompt holds
// PROMPT_MAX characters, so long findings are cut first, and minor ones go only as a last resort.
const PROMPT_MAX = 3900;
export const VERDICTS = ["Needs your call", "Fixed", "False positive", "Won't fix"];
export function findingsPrompt(pr, tasks) {
  const all = mergedFindings(tasks);
  const build = (cut, list) => {
    const short = (f) => findingLine({ ...f, issue: f.issue.length > cut ? `${f.issue.slice(0, cut).trimEnd()}…` : f.issue,
      fix: f.fix && f.fix.length > cut ? `${f.fix.slice(0, cut).trimEnd()}…` : f.fix });
    const left = all.length - list.length;
    return [`Fix pull request #${pr.number} (${pr.url}) after a deep review by ${tasks.map(who).join(" and ")}.`,
      `Findings, most severe first:\n${list.map(short).join("\n")}${left ? `\n(and ${left} minor notes left out for length)` : ""}`,
      "Decide every finding. Fix each blocker and major unless the code shows it is not a bug; fix a minor one when it is cheap and safe. Check a finding against the code before you trust it: reviewers are sometimes wrong. Keep the change to these findings and run the repository's tests.",
      `In your report's details, write one line per finding, in this order, each starting with its verdict and its file:line:\n${VERDICTS.map((v) => `${v}: <file:line> — ${({ "Needs your call": "the question the person must answer", Fixed: "what changed", "False positive": "why it is not a bug, with the code that shows it", "Won't fix": "why not (out of scope, risk, cost)" })[v]}`).join("\n")}`,
    ].join("\n\n");
  };
  const minors = all.filter((f) => f.level === "minor").length;
  for (const cut of [400, 200, 120, 80, 50]) {
    const text = build(cut, all);
    if (text.length <= PROMPT_MAX) return text;
  }
  for (let drop = 1; drop <= minors; drop++) {
    const text = build(50, all.slice(0, all.length - drop));
    if (text.length <= PROMPT_MAX) return text;
  }
  return build(50, all.filter((f) => f.level !== "minor")).slice(0, PROMPT_MAX);
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

const OUTCOMES = ["Needs your call", "Fixed", "Changed", "False positive", "Won't fix", "Not touched"];
const fileName = (where) => String(where ?? "").trim().replace(/:\d.*$/, "").split("/").pop();
const stem = (name) => name.replace(/\.[^.]+$/, "");

// What a fix run did with each finding of the deep review it came from: its writer's verdict when it gave one; else
// "Changed" when a line of its report or the run's diff names that finding's file, with the line as why; else
// "Not touched". `changed` is the run's changed paths, when read.
// One finding, the same wherever it shows: a deep review's glance or a run reviewer's card.
export const findingKey = (f) => `${f.level}|${f.where ?? ""}|${f.issue}`;

// What the writer gets for the findings picked with Ask to fix: each one whole, then the person's own words.
// The coordinator keeps 4000 characters, so long parts are cut before anything is dropped.
export function fixRequest(findings, note = "") {
  const words = note.trim(), cut = (s, n) => (s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
  const build = (n) => [`Fix ${findings.length === 1 ? "this finding" : `these ${findings.length} findings`}. Check each against the code first; if one is not a bug or not worth fixing, say why in your report instead.`,
    ...findings.map((f, i) => [`${i + 1}. [${f.level}] ${f.where || "no file"} — ${cut(f.issue, n)}`,
      ...(f.fix ? [`   Fix: ${cut(f.fix, n)}`] : []), ...(f.proof ? [`   Proof: ${cut(f.proof, n)}`] : []),
      ...(f.by?.length ? [`   Found by: ${f.by.join(", ")}`] : [])].join("\n")),
    ...(words ? [`Also: ${words}`] : [])].join("\n\n");
  for (const n of [Infinity, 400, 200, 120, 60]) { const text = build(n); if (text.length <= PROMPT_MAX) return text; }
  return build(60).slice(0, PROMPT_MAX);
}

export function fixOutcome(findings, task, changed = []) {
  const report = [...(task.attempts ?? [])].reverse().find((a) => a.role === "executor" && a.report)?.report;
  const said = (fixChecklist(task)?.groups ?? []).flatMap((g) => g.items.map((i) => ({ ...i, verdict: g.verdict })));
  const files = new Set(changed.map((p) => p.split("/").pop()));
  const rows = findings.map((f) => {
    const name = fileName(f.where), mention = (text) => Boolean(name) && (text.includes(name) || (stem(name).length >= 6 && text.includes(stem(name))));
    const verdict = said.find((i) => mention(i.text));
    if (verdict) return { f, outcome: verdict.verdict, why: verdict.text.replace(/^\S+\s+[—-]\s+/, "") };
    // A report line naming the file says it was touched, not why: one line can name several findings.
    const line = (report?.details ?? []).find(mention);
    return { f, outcome: line || files.has(name) ? "Changed" : "Not touched", why: "" };
  });
  const groups = OUTCOMES.map((outcome) => ({ outcome, rows: rows.filter((r) => r.outcome === outcome) })).filter((g) => g.rows.length);
  const majors = rows.filter((r) => r.f.level !== "minor"), left = majors.filter((r) => ["Not touched", "Needs your call"].includes(r.outcome));
  const tally = majors.length ? `${majors.length - left.length} of ${majors.length} ${majors.length === 1 ? "major" : "majors"} handled${left.length ? ` · ${left.length} left` : ""}` : "No majors";
  return { groups, rows, majors, left, tally, head: groups.map((g) => `${g.rows.length} ${g.outcome.toLowerCase()}`).join(" · ") };
}
