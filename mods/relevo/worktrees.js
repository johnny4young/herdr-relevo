import { exec, home, spaces, panes } from "herdr";
import { REPOS_ROOT as ROOT } from "./config.js";

// Every linked worktree of the clones in ROOT, as "<main>\t<porcelain line>".
const LIST = 'for d in "$1"/*/; do [ -d "$d.git" ] || continue; git -C "$d" worktree list --porcelain 2>/dev/null | awk -v d="${d%/}" \'{ print d "\t" $0 }\'; done';

function parse(out) {
  const list = [];
  let cur = null;
  for (const line of out.split("\n")) {
    const [main, rest = ""] = line.split("\t");
    if (rest.startsWith("worktree ")) {
      cur = { main, path: rest.slice(9) };
      if (cur.path !== main) list.push(cur);
    } else if (cur && rest.startsWith("branch refs/heads/")) cur.branch = rest.slice(18);
    else if (cur && (rest === "locked" || rest.startsWith("locked "))) cur.locked = true;
    else if (cur && (rest === "prunable" || rest.startsWith("prunable "))) cur.missing = true;
  }
  return list;
}

// "<path>\t<newest of last commit, index and HEAD>": the index moves with any git use there.
const TOUCHED = 'for w; do g=$(git -C "$w" rev-parse --absolute-git-dir 2>/dev/null) || continue; c=$(git -C "$w" log -1 --format=%ct 2>/dev/null); m=$(stat -f %m "$g/index" "$g/HEAD" 2>/dev/null | sort -n | tail -1); printf "%s\t%s\n" "$w" "$(printf "%s\n%s\n" "${c:-0}" "${m:-0}" | sort -n | tail -1)"; done';

const slug = (url) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url.trim())?.[1] ?? null;

// GitHub's merged PRs per repo, asked again after MERGED_TTL or on a forced refresh;
// scans also run on every space change, and this is the network call in them.
const MERGED_TTL = 15 * 60 * 1000;
const mergedOnGitHub = new Map();

async function githubMerged(main, force) {
  const hit = mergedOnGitHub.get(main);
  if (hit && !force && Date.now() - hit.at < MERGED_TTL) return hit.branches;
  const branches = new Set();
  const repo = slug((await exec("git", ["-C", main, "remote", "get-url", "origin"])).stdout);
  if (repo) {
    const r = await exec("gh", ["pr", "list", "-R", repo, "--state", "merged", "--limit", "100", "--json", "headRefName"]);
    if (r.code !== 0) return hit?.branches ?? branches;
    for (const p of JSON.parse(r.stdout)) branches.add(p.headRefName);
  }
  mergedOnGitHub.set(main, { at: Date.now(), branches });
  return branches;
}

// Branches whose PR merged on GitHub, and local branches whose upstream is gone (local, so always fresh).
async function mergedBranches(main, force) {
  const out = new Set(await githubMerged(main, force));
  const refs = await exec("git", ["-C", main, "for-each-ref", "--format=%(refname:short)\t%(upstream:track)", "refs/heads"]);
  for (const l of refs.stdout.split("\n")) if (l.endsWith("[gone]")) out.add(l.split("\t")[0]);
  return out;
}

export async function scanWorktrees(force = false) {
  const list = parse((await exec("sh", ["-c", LIST, "sh", `${home()}/${ROOT}`])).stdout).filter((w) => !w.missing);
  const open = new Set([...spaces().map((s) => s.folder), ...panes().map((p) => p.cwd)].filter(Boolean));
  const merged = {};
  for (const main of new Set(list.map((w) => w.main))) merged[main] = await mergedBranches(main, force);
  const touched = new Map((await exec("sh", ["-c", TOUCHED, "sh", ...list.map((w) => w.path)])).stdout
    .split("\n").filter(Boolean).map((l) => l.split("\t")));
  for (const w of list) {
    w.at = Number(touched.get(w.path)) || 0;
    w.repo = w.main.split("/").pop();
    w.name = w.path.split("/").pop();
    w.space = spaces().find((s) => s.folder === w.path)?.id ?? null;
    w.open = [...open].some((p) => p === w.path || p.startsWith(`${w.path}/`));
    w.merged = Boolean(w.branch && merged[w.main].has(w.branch));
    if (w.merged) {
      w.dirty = (await exec("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: w.path })).stdout.trim() !== "";
    }
  }
  return list.sort((a, b) => b.at - a.at);
}

// Never forced: git keeps a worktree with changes, and -d keeps a branch with unmerged commits.
export async function removeWorktree(w) {
  const r = await exec("git", ["-C", w.main, "worktree", "remove", w.path]);
  if (r.code !== 0) return r.stderr.trim().split("\n")[0] || "git worktree remove failed";
  if (w.branch) await exec("git", ["-C", w.main, "branch", "-d", w.branch]);
  return null;
}

// Where a branch is checked out: the clone itself or one of its worktrees; null when nowhere.
export async function checkoutOf(clone, branch) {
  const out = (await exec("git", ["-C", clone, "worktree", "list", "--porcelain"])).stdout;
  let path = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

// When each checkout was last used: path -> seconds (newest of its last commit, index and HEAD).
export async function touchedAt(paths) {
  if (!paths.length) return new Map();
  const out = (await exec("sh", ["-c", TOUCHED, "sh", ...paths])).stdout;
  return new Map(out.split("\n").filter(Boolean).map((l) => {
    const [path, at] = l.split("\t");
    return [path, Number(at) || 0];
  }));
}
