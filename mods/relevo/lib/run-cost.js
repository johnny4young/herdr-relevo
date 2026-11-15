// What a run's attempts cost, from the token scanner's report (`report.runs`); pure, so the tests can feed it fixtures.
// A session counts for an attempt only when its folder is the run's worktree or inside it, and only for the minutes
// inside the attempt's window. An attempt whose recorded transcript is among those sessions counts that one alone.
// A run on existing sessions has no worktree, so it counts time and no tokens.

const time = (iso) => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : null; };
const inside = (folder, root) => folder === root || folder.startsWith(`${root}/`);
const sessionOf = (transcript) => transcript.split("/").pop().replace(/\.jsonl$/, "");
const round = (minutes) => Math.round(minutes * 10) / 10;

// From the assignment to the report, timeout or reconciliation. An older record without an end takes the next
// attempt's start; one still running takes now, up to its time limit.
export function attemptWindow(attempt, task, now = Date.now()) {
  const start = time(attempt?.at);
  if (start == null) return null;
  const next = task.attempts[task.attempts.findIndex((a) => a.id === attempt.id) + 1];
  const running = attempt.state === "running" ? Math.min(now, start + (task.maxMinutes ?? 120) * 60000) : null;
  const end = time(attempt.endedAt) ?? time(attempt.snapshot?.at) ?? time(next?.at) ?? running;
  return end != null && end >= start ? { start, end } : null;
}

function spansOf(attempt, task, sessions, now) {
  const window = attemptWindow(attempt, task, now), root = task.worktree?.path, found = [];
  if (!window || !root) return { window, found };
  const from = Math.floor(window.start / 60000), to = Math.floor(window.end / 60000);
  const here = (sessions ?? []).filter((s) => typeof s?.folder === "string" && inside(s.folder, root));
  const id = typeof attempt.transcript === "string" ? sessionOf(attempt.transcript) : null, own = here.some((s) => s.id === id);
  for (const s of here) {
    if (own && s.id !== id) continue;
    for (const [minute, context, output] of s.spans ?? []) {
      if (minute >= from && minute <= to) found.push({ key: `${s.folder}\t${s.id}\t${minute}`, context, output });
    }
  }
  return { window, found };
}

function cost(parts) {
  const seen = new Map();
  let ms = 0;
  for (const { window, found } of parts) {
    if (window) ms += window.end - window.start;
    for (const span of found) seen.set(span.key, span);
  }
  const output = [...seen.values()].reduce((n, s) => n + s.output, 0), context = [...seen.values()].reduce((n, s) => n + s.context, 0);
  return { output, context, total: output + context, minutes: round(ms / 60000) };
}

export function attemptTokens(attempt, task, sessions, now = Date.now()) {
  return cost([spansOf(attempt, task, sessions, now)]);
}

// Every attempt of the goal's tasks still in the queue; a minute two attempts share is counted once.
export function goalCost(goal, tasks, sessions, now = Date.now()) {
  return cost((tasks ?? []).filter((task) => task.goalId === goal.id)
    .flatMap((task) => task.attempts.map((attempt) => spansOf(attempt, task, sessions, now))));
}
