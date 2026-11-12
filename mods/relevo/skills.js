import { shared, setShared } from "herdr";
import { launchInRepo } from "./accounts.js";
import { notify } from "herdr";
import { SKILLS as SKILL_NAMES } from "./config.js";
import { openPrSession } from "./prsession.js";
import { conflictsPrompt } from "./lib/prmenu.js";

// PRs a skill was started on, so a card can follow its agent: url -> {tab, skill, account, at}.
export const LAUNCHED = "relevo.launched";
// Merge conflicts have a built-in prompt; a configured skill takes its place.
export const SKILLS = {
  conflicts: { name: "resolve conflicts", verb: "conflicts" },
  ...Object.fromEntries(Object.entries(SKILL_NAMES).filter(([, name]) => name).map(([verb, name]) => [verb, { name, verb, command: name }])),
};
export const configuredSkill = (verb) => Object.hasOwn(SKILLS, verb) ? SKILLS[verb] : null;
export const launched = () => shared(LAUNCHED) ?? {};
const launchAttempts = new Map();
const tabName = (pr, skill) => `${pr.repo.split("/")[1]}#${pr.number} · ${SKILLS[skill].verb}`;

// Starts the skill on the PR and remembers it, so the card can follow its agent.
// Conflicts are resolved on the PR's branch, so they run in a worktree of it rather than in the clone.
export function launchSkill(pr, skill, account, folder) {
  const s = configuredSkill(skill);
  if (!s) {
    notify({ title: "Skill unavailable", body: "This action is no longer configured. Open the skill picker to choose another action.", level: "warning" });
    return null;
  }
  const tab = tabName(pr, skill);
  const prompt = s.command ? `/${s.command} ${pr.url}` : conflictsPrompt(pr);
  // Preparation is not a launch receipt. Keep existing history until the
  // native session request returns, and never overwrite a later request.
  const attempt = {};
  launchAttempts.set(pr.url, attempt);
  const remember = () => {
    if (launchAttempts.get(pr.url) === attempt) setShared(LAUNCHED, { ...launched(), [pr.url]: { tab, skill, account, at: Date.now() / 1000 } });
  };
  const finish = () => { if (launchAttempts.get(pr.url) === attempt) launchAttempts.delete(pr.url); };
  if (skill !== "conflicts") {
    try { launchInRepo({ repo: pr.repo, folder, tab, account, prompt }); remember(); }
    finally { finish(); }
    return null;
  }
  return openPrSession(pr, folder, account, { prompt, tab, purpose: "resolve conflicts" }).then((error) => {
    if (!error) { remember(); return null; }
    notify({ title: `Could not open ${pr.repo.split("/")[1]} #${pr.number}`, body: error, level: "warning" });
    return error;
  }).finally(finish);
}
