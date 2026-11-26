// One folder's git: its repo, branch, ahead/behind and how many files changed. null: not a repo.
import { exec } from "herdr";

const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const lines = (r) => r.stdout.replace(/\n$/, "");
// Reads only: no index.lock held while an agent commits, and no program the repo's config names (fsmonitor, external diff).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.external=",
  "-c", "submodule.recurse=false", "-c", "status.submoduleSummary=false"];

// Parses `git status --porcelain=v2 --branch`: branch name, ahead/behind counts and changed file count in one call.
export function parsePorcelainV2(stdout) {
  let branch = null, ahead = 0, behind = 0, changed = 0;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      branch = head && head !== "(detached)" ? head : null;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]) || 0; behind = Number(m[2]) || 0; }
    } else if (!line.startsWith("#")) {
      changed += 1;
    }
  }
  return { branch, ahead, behind, changed };
}

export async function readGit(cwd, on = null, known = null) {
  const git = (...args) => exec("git", [...READ, ...args], { cwd, on });
  const statusArgs = ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignore-submodules=all"];
  // Known repo refreshes run a single git status call instead of 5 subprocesses.
  if (known?.top && known?.gitDir) {
    const status = await git(...statusArgs);
    if (status.code !== 0) {
      if (/not a git repository/i.test(status.stderr ?? "")) return null;
      throw Error("git did not answer");
    }
    return { ...known, ...parsePorcelainV2(status.stdout) };
  }
  // Two rev-parse reads on first discovery: a folder name may itself contain a newline.
  const [top, common, status] = await Promise.all([
    git("rev-parse", "--path-format=absolute", "--show-toplevel"),
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    git(...statusArgs),
  ]);
  if (top.code !== 0 || common.code !== 0) {
    // Only git's own "no" means no repo; anything else is asked again later.
    if (/not a git repository/i.test(top.code !== 0 ? top.stderr : common.stderr)) return null;
    throw Error("git did not answer");
  }
  const root = lines(top), repo = lines(common);
  const parsed = status.code === 0 ? parsePorcelainV2(status.stdout) : { branch: null, ahead: 0, behind: 0, changed: 0 };
  return {
    name: repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, ""),
    ...parsed,
    top: root, repo: JSON.stringify([on, repo]), gitDir: repo, linked: repo !== `${root}/.git`,
  };
}
