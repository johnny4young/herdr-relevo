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
export const launched = () => shared(LAUNCHED) ?? {};
const tabName = (pr, skill) => `${pr.repo.split("/")[1]}#${pr.number} · ${SKILLS[skill].verb}`;

// Starts the skill on the PR and remembers it, so the card can follow its agent.
// Conflicts are resolved on the PR's branch, so they run in a worktree of it rather than in the clone.
export function launchSkill(pr, skill, account, folder) {
  const tab = tabName(pr, skill), s = SKILLS[skill];
  const prompt = s.command ? `/${s.command} ${pr.url}` : conflictsPrompt(pr);
  setShared(LAUNCHED, { ...launched(), [pr.url]: { tab, skill, account, at: Date.now() / 1000 } });
  if (skill !== "conflicts") {
    launchInRepo({ repo: pr.repo, folder, tab, account, prompt });
    return null;
  }
  return openPrSession(pr, folder, account, { prompt, tab, purpose: "resolve conflicts" }).then((error) => {
    if (!error) return;
    const { [pr.url]: _, ...rest } = launched();
    setShared(LAUNCHED, rest);
    notify({ title: `Could not open ${pr.repo.split("/")[1]} #${pr.number}`, body: error, level: "warning" });
  });
}
