// One folder's git: its repo, branch, ahead/behind and how many files changed. null: not a repo.
import { exec } from "herdr";

const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const lines = (r) => r.stdout.replace(/\n$/, "");
// Reads only: no index.lock held while an agent commits, and no program the repo's config names (fsmonitor, external diff).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.external=",
  "-c", "submodule.recurse=false", "-c", "status.submoduleSummary=false"];

export async function readGit(cwd, on = null) {
  const git = (...args) => exec("git", [...READ, ...args], { cwd, on });
  // Two reads: a folder name may itself contain a newline.
  const [top, common] = await Promise.all([
    git("rev-parse", "--path-format=absolute", "--show-toplevel"),
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  ]);
  if (top.code !== 0 || common.code !== 0) {
    // Only git's own "no" means no repo; anything else is asked again later.
    if (/not a git repository/i.test(top.code !== 0 ? top.stderr : common.stderr)) return null;
    throw Error("git did not answer");
  }
  const root = lines(top), repo = lines(common);
  const [branch, counts, status] = await Promise.all([
    git("symbolic-ref", "-q", "HEAD"),
    git("rev-list", "--left-right", "--count", "HEAD...@{upstream}"),
    git("status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all"),
  ]);
  const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  return {
    name: repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, ""),
    branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : null,
    ahead: ahead || 0, behind: behind || 0,
    changed: status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0,
    top: root, repo: JSON.stringify([on, repo]), gitDir: repo, linked: repo !== `${root}/.git`,
  };
}
