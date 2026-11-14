// What a run's agent reports beyond its status and summary: details, a reviewer's findings by level, what it
// could not prove or run, and how the work is going while it lasts. Agents write it, so every field is cleaned.
export const LEVELS = ['blocker', 'major', 'minor'];
const LINE = 400, ITEMS = 30, STATUS_LINE = 60;

const line = (value, max = LINE) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const list = (value) => (Array.isArray(value) ? value.map((item) => line(item)).filter(Boolean).slice(0, ITEMS) : []);
const atOrAbove = (level, bar) => LEVELS.indexOf(level) <= LEVELS.indexOf(LEVELS.includes(bar) ? bar : 'major');

export function cleanReport(report) {
  const findings = (Array.isArray(report?.findings) ? report.findings : []).map((f) => ({
    level: LEVELS.includes(f?.level) ? f.level : 'major', where: line(f?.where, 200), issue: line(f?.issue), fix: line(f?.fix),
  })).filter((f) => f.issue).slice(0, ITEMS);
  return { details: list(report?.details), findings, notProven: list(report?.notProven), notRun: list(report?.notRun) };
}

// A reviewer that lists findings is held to them: changes are requested only for one at or above the bar.
export function reviewStatus(status, findings, bar) {
  if (status === 'blocked' || !findings.length) return status;
  return findings.some((f) => atOrAbove(f.level, bar)) ? 'changes_requested' : 'completed';
}

export const findingLine = (f) => `[${f.level}] ${f.where ? `${f.where}: ` : ''}${f.issue}${f.fix ? ` Fix: ${f.fix}` : ''}`;

// What goes back to the implementer: the findings it must fix, then the rest as optional.
export function feedbackOf(report, bar) {
  const must = report.findings.filter((f) => atOrAbove(f.level, bar)), rest = report.findings.filter((f) => !must.includes(f));
  return [report.summary,
    must.length ? `Must fix:\n${must.map((f) => `- ${findingLine(f)}`).join('\n')}` : '',
    rest.length ? `Optional, below the bar:\n${rest.map((f) => `- ${findingLine(f)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

// done: percent of the whole task; left: minutes the agent estimates.
export function cleanProgress(raw) {
  const text = line(raw?.line, STATUS_LINE);
  if (!text) return null;
  const within = (value, max) => (Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : null);
  return { line: text, done: within(raw.done, 100), left: within(raw.left, 1440) };
}

export function progressLine(progress) {
  if (!progress?.line) return '';
  const left = progress.left == null ? '' : progress.left >= 60 ? `~${Math.floor(progress.left / 60)}h ${progress.left % 60}m left` : `~${progress.left}m left`;
  return [progress.line, progress.done == null ? '' : `${progress.done}%`, left].filter(Boolean).join(' · ');
}

// What a report says beyond its summary, one line each: findings by level, then what was not run or proven.
export const reportNotes = (report) => [
  ...(report?.findings ?? []).map(findingLine),
  ...(report?.notRun ?? []).map((item) => `Not run: ${item}`),
  ...(report?.notProven ?? []).map((item) => `Not proven: ${item}`),
];
