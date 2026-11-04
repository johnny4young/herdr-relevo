import { exec, home, notify, spaces, panes } from "herdr";
import { REPOS_ROOT as ROOT } from "./config.js";
import { mergedHeads } from "./lib/github.js";
import { GIT_READ, githubRepo, withoutLogin } from "./lib/git.js";
import { groupOf } from "./lib/trees.js";

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

// GitHub's merged PRs per repo, asked again after MERGED_TTL or on a forced refresh;
// scans also run on every space change, and this is the network call in them.
const MERGED_TTL = 15 * 60 * 1000;
const mergedOnGitHub = new Map();

async function githubMerged(main, force) {
  const hit = mergedOnGitHub.get(main);
  if (hit && !force && Date.now() - hit.at < MERGED_TTL) return hit.branches;
  const branches = new Set();
  const repo = githubRepo(withoutLogin((await exec("git", ["-C", main, "remote", "get-url", "origin"])).stdout));
  if (repo) {
    const r = await exec("gh", ["pr", "list", "-R", repo, "--state", "merged", "--limit", "100", "--json", "headRefName,isCrossRepository"]);
    if (r.code !== 0) return hit?.branches ?? branches;
    for (const name of mergedHeads(JSON.parse(r.stdout))) branches.add(name);
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
    w.space = spaces().find((s) => !s.machine && s.folder === w.path)?.id ?? null;
    w.open = [...open].some((p) => p === w.path || p.startsWith(`${w.path}/`));
    w.merged = Boolean(w.branch && merged[w.main].has(w.branch));
    if (w.merged) {
      w.dirty = (await statusOf(w)).stdout.trim() !== "";
      w.ignored = worthKeeping((await ignoredFiles(w)).paths);
    }
  }
  return list.sort((a, b) => b.at - a.at);
}

// Only what an install or a tool always brings back. "build" or "out" can hold someone's work, so those get named.
const REBUILT = new Set(["node_modules", ".build", "__pycache__", ".pytest_cache", ".next", ".nuxt", ".turbo", ".gradle", ".venv", "DerivedData", ".DS_Store"]);
const ignoredFiles = async (w) => {
  const r = await exec("git", [...GIT_READ, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { cwd: w.path });
  return { ...r, paths: r.stdout.split("\0").filter(Boolean).map((l) => l.replace(/\/$/, "")) };
};
// git also lists the folders holding ignored entries; only the entries themselves count.
const worthKeeping = (paths) => paths.filter((l) => !REBUILT.has(l.split("/").pop()) && !paths.some((o) => o.startsWith(`${l}/`)));
// showUntrackedFiles=no would hide new files from this check and from git's own refusal.
const statusOf = (w) => exec("git", [...GIT_READ, "status", "--porcelain", "--untracked-files=normal"], { cwd: w.path });

const baseOf = new Map();
export async function baseBranch(main) {
  if (baseOf.has(main)) return baseOf.get(main);
  const head = await exec("git", [...GIT_READ, "-C", main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let base = head.code === 0 ? head.stdout.trim() : "";
  for (const name of ["origin/main", "origin/master"]) {
    if (base) break;
    if ((await exec("git", [...GIT_READ, "-C", main, "rev-parse", "-q", "--verify", name])).code === 0) base = name;
  }
  if (base) baseOf.set(main, base);
  return base;
}

// What removing this worktree would lose. Anything unreadable counts as work.
export async function treeState(w) {
  try {
    const git = (args) => exec("git", [...GIT_READ, ...args], { cwd: w.path });
    const base = await baseBranch(w.main);
    const status = await statusOf(w), pushed = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    const cherry = base ? await git(["cherry", base, "HEAD"]) : { code: 1 }, ignored = await ignoredFiles(w);
    if (!base || [status, pushed, cherry, ignored].some((r) => r.code !== 0)) return { unreadable: true };
    return {
      branch: w.branch ?? null, locked: Boolean(w.locked),
      files: status.stdout.split("\n").filter(Boolean).length,
      unpushed: Number(pushed.stdout.trim()) || 0,
      unique: cherry.stdout.split("\n").filter((l) => l.startsWith("+")).length,
      ignored: worthKeeping(ignored.paths),
    };
  } catch {
    return { unreadable: true };
  }
}

export async function treeSize(w) {
  const r = await exec("du", ["-sk", w.path]);
  return r.code === 0 ? Number(r.stdout.split(/\s/)[0]) || 0 : 0;
}

// Local refs can be stale, so it counts as pushed only if a branch on GitHub sits on this very commit.
async function onGitHub(w) {
  const head = await exec("git", [...GIT_READ, "rev-parse", "HEAD"], { cwd: w.path });
  const remote = await exec("git", [...GIT_READ, "ls-remote", "--heads", "origin"], { cwd: w.path });
  return head.code === 0 && remote.code === 0
    && remote.stdout.split("\n").some((l) => l.split(/\s/)[0] === head.stdout.trim());
}

export async function ignoredPaths(w) {
  const r = await ignoredFiles(w);
  return r.code === 0 ? r.paths : null;
}

// A repo inside ignored or untracked folders, not a tool's clones: "" for none, null if the search can't finish.
export async function nestedRepo(w, paths) {
  const status = await statusOf(w);
  if (status.code !== 0) return null;
  const untracked = status.stdout.split("\n").filter((l) => l.startsWith("?? ") && l.endsWith("/")).map((l) => l.slice(3, -1).replace(/^"|"$/g, ""));
  const dirs = [...paths.filter((p) => !REBUILT.has(p.split("/").pop())), ...untracked].map((p) => `./${p}`);
  if (!dirs.length) return "";
  const skip = [...REBUILT].flatMap((name, i) => (i ? ["-o", "-name", name] : ["-name", name]));
  const found = await exec("find", [...dirs, "(", ...skip, ")", "-prune", "-o", "-name", ".git", "-print"], { cwd: w.path });
  if (found.code !== 0) return null;
  return found.stdout.split("\n").find(Boolean)?.replace(/^\.\//, "").replace(/\/?\.git$/, "") ?? "";
}

export async function isLocked(w) {
  const out = (await exec("git", ["-C", w.main, "worktree", "list", "--porcelain"])).stdout;
  return out.split("\n\n").some((b) => b.split("\n")[0] === `worktree ${w.path}` && /^locked\b/m.test(b));
}

// Looks again right before removing, since the last scan can be minutes old and closing a space can't be undone.
export async function removalCheck(w) {
  try {
    const inside = (p) => p === w.path || p?.startsWith(`${w.path}/`);
    const space = spaces().find((s) => !s.machine && s.folder === w.path);
    const own = new Set((space?.tabs ?? []).map((t) => t.id));
    const here = panes().filter((p) => inside(p.cwd));
    // A space's own terminals close with it; any other would lose its folder.
    if (here.some((p) => !own.has(p.tab))) return { error: "open in a terminal" };
    if (here.some((p) => p.status === "working")) return { error: "an agent is working here" };
    if (await isLocked(w)) return { error: "locked" };
    if (w.group) {
      const at = (await touchedAt([w.path])).get(w.path) ?? 0;
      if (groupOf(await treeState(w), at, Date.now() / 1000) !== w.group) return { error: "changed, look again" };
      if (w.group === "pushed" && !await onGitHub(w)) return { error: "not on GitHub anymore" };
    }
    const git = (args) => exec("git", [...GIT_READ, ...args], { cwd: w.path });
    const tracked = await git(["ls-files", "--stage", "-v"]);
    if (tracked.code !== 0) return { error: "could not check its files" };
    const rows = tracked.stdout.split("\n").filter(Boolean);
    // git refuses a worktree with submodules, and only after the space would have closed.
    if (rows.some((l) => /^\S+ 160000 /.test(l))) return { error: "has submodules" };
    if (rows.some((l) => /^[Sa-z]/.test(l))) return { error: "has files git skips" };
    const status = await statusOf(w);
    if (status.code !== 0) return { error: "could not check its files" };
    if (status.stdout.trim()) return { error: "uncommitted changes" };
    const ignored = await ignoredFiles(w);
    if (ignored.code !== 0) return { error: "could not check its files" };
    // Clones under these belong to the tool that made them, like SwiftPM's .build/checkouts.
    const dirs = ignored.paths.filter((p) => !REBUILT.has(p.split("/").pop())).map((p) => `./${p}`);
    const skip = [...REBUILT].flatMap((name, i) => (i ? ["-o", "-name", name] : ["-name", name]));
    const nested = dirs.length ? await exec("find", [...dirs, "(", ...skip, ")", "-prune", "-o", "-name", ".git", "-print"], { cwd: w.path }) : { code: 0, stdout: "" };
    if (nested.code !== 0) return { error: "could not check its files" };
    const repo = nested.stdout.split("\n").find(Boolean);
    if (repo) return { error: `holds a repo: ${repo.replace(/^\.\//, "").replace(/\/?\.git$/, "")}` };
    return { space: space?.id ?? null, ignored: worthKeeping(ignored.paths) };
  } catch {
    return { error: "could not check its files" };
  }
}

// Never forced: git keeps a worktree with changes, and -d keeps a branch with unmerged commits.
export async function removeWorktree(w) {
  const r = await exec("git", ["-C", w.main, "worktree", "remove", w.path]);
  if (r.code !== 0) return r.stderr.trim().split("\n")[0] || "git worktree remove failed";
  if (w.branch) {
    const b = await exec("git", ["-C", w.main, "branch", "-d", w.branch]);
    if (b.code !== 0) notify({ title: `Kept branch ${w.branch}`, body: b.stderr.trim().split("\n")[0], level: "warning" });
  }
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
