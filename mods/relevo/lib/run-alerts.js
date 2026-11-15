// Which run results are new since the last look: a task that waits on you, once per revision and attempt.
export const resultMark = (task) => `${task.id}@${task.revision ?? ""}:${task.round ?? 0}`;

export function newResults(known, tasks) {
  const marks = tasks.filter((task) => task.state === "needs_you").map((task) => [task, resultMark(task)]);
  return { fresh: known ? marks.filter(([, mark]) => !known.includes(mark)).map(([task]) => task) : [], marks: marks.map(([, mark]) => mark) };
}
