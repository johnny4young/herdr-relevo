// Ctrl/Cmd-click on a GitHub pull request in a terminal opens it in Review, when its repository is cloned here.
// Anything else, or a PR Relevo can't read, goes on to the browser.
import { exec, home } from "herdr";
import { REPOS_ROOT } from "./config.js";
import { reviewPR } from "./review.js";
import { githubRepo } from "./lib/git.js";

export const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export async function handleLink({ link, source }) {
  const m = PR_URL.exec(link?.kind === "url" ? link.url : "");
  if (!m || source?.machine) return "pass";
  const [, owner, name, number] = m, repo = `${owner}/${name}`;
  const clone = `${home()}/${REPOS_ROOT}/${name}`;
  // Its origin, or upstream in a fork: any remote of the clone may be the PR's repository.
  const remotes = await exec("git", ["-C", clone, "remote", "-v"]).catch(() => null);
  const repos = remotes?.code === 0 ? remotes.stdout.split("\n").map((l) => githubRepo(l.split(/\s+/)[1])?.toLowerCase()) : [];
  if (!repos.includes(repo.toLowerCase())) return "pass";
  const r = await exec("gh", ["pr", "view", number, "-R", repo, "--json", "number,url,baseRefName,headRefName,isCrossRepository"]).catch(() => null);
  if (r?.code !== 0) return "pass";
  let pr;
  try { pr = { ...JSON.parse(r.stdout), repo }; } catch { return "pass"; }
  return (await reviewPR(pr, clone)) ? "handled" : "pass";
}
