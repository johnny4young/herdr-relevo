import { appHome, readTextFile, writeTextFile, setShared } from "herdr";
import { parseGoals, saveGoal } from "./lib/goals.js";
export const GOALS_CHANGED = "relevo.goals.changed";
export const goalsPath = () => `${appHome()}/relevo-goals.json`;
export async function readGoals() {
  const raw = await readTextFile(goalsPath());
  return { raw, doc: parseGoals(raw) };
}
export async function writeGoal(goal, expectedVersion) {
  const { raw, doc } = await readGoals();
  const next = saveGoal(doc, goal, expectedVersion);
  // The app rejects concurrent file changes; never silently retry a stale human edit.
  await writeTextFile(goalsPath(), JSON.stringify(next, null, 2), raw);
  setShared(GOALS_CHANGED, { revision: next.revision, at: Date.now() });
  return next;
}
