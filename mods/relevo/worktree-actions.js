// What a worktree with work can do before it goes: save its changes or commits, push a backup, delete it all.
import { exec, home, panes, readTextFile, spaces } from "herdr";
import * as config from "./config.js";
import { GIT_READ } from "./lib/git.js";
import { RECENT_AFTER, plural, sizeOf } from "./lib/trees.js";
import { baseBranch, ignoredPaths, isLocked, nestedRepo, touchedAt, treeSize, treeState } from "./worktrees.js";

export const backupsRoot = () => `${home()}/${config.BACKUPS_ROOT ?? "relevo-backups"}`;

// A Codex worktree is <task>/<repo>, so the task names it.
function nameOf(w) {
  const parts = w.path.split("/"), last = parts.at(-1);
  return (last === w.repo ? parts.at(-2) : last).replace(/[^\w.-]+/g, "-");
}
const folderOf = (w, root) => `${root}/${w.repo}/${nameOf(w)}`;
const git = (w, args) => exec("git", [...GIT_READ, ...args], { cwd: w.path });
const withIndex = (w, index, args) => exec("env", [`GIT_INDEX_FILE=${index}`, "git", ...GIT_READ, ...args], { cwd: w.path });
const line = (r) => (r.code === 0 ? r.stdout.trim() : "");
const failure = (r, fallback) => r.stderr?.trim().split("\n")[0] || fallback;
const writePrivate = (path, text) => exec("sh", ["-c", 'umask 077; printf %s "$2" > "$1"', "sh", path, text]);

async function tempDir() {
  return line(await exec("sh", ["-c", 'mktemp -d "${TMPDIR:-/tmp}/relevo-tree.XXXXXX"']));
}
const dropDir = (dir) => (dir ? exec("rm", ["-rf", "--", dir]) : null);

// The tree this worktree would commit to, through a copy of its index so the real one isn't touched.
async function workingTree(w, dir) {
  const gitDir = line(await git(w, ["rev-parse", "--absolute-git-dir"]));
  if (!gitDir) return { error: "could not check its files" };
  const index = `${dir}/index`;
  await exec("sh", ["-c", '[ ! -e "$1" ] || cp "$1" "$2"', "sh", `${gitDir}/index`, index]);
  if ((await withIndex(w, index, ["add", "-A"])).code !== 0) return { error: "could not read its files" };
  const stage = await withIndex(w, index, ["ls-files", "--stage", "-v"]);
  const rows = stage.stdout.split("\n").filter(Boolean);
  if (rows.some((l) => /^\S+ 160000 /.test(l))) return { error: "holds a repo" };
  if (rows.some((l) => /^[Sa-z]/.test(l))) return { error: "has files git skips" };
  const tree = line(await withIndex(w, index, ["write-tree"]));
  return tree ? { tree, index } : { error: "could not read its files" };
}

async function readLatest(w, root) {
  try {
    const saved = JSON.parse(await readTextFile(`${folderOf(w, root)}/latest.json`));
    return saved?.path === w.path ? saved : null;
  } catch {
    return null;
  }
}

async function remember(w, root, fields) {
  const latest = { ...await readLatest(w, root), path: w.path, ...fields };
  return writePrivate(`${folderOf(w, root)}/latest.json`, JSON.stringify(latest, null, 2));
}

async function newBackupDir(w, root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `${folderOf(w, root)}/${stamp}`;
  const made = await exec("sh", ["-c", 'umask 077; mkdir -p "$1"', "sh", dir]);
  return made.code === 0 ? dir : null;
}

// Whether what's here now is what was saved: a later edit or commit means it isn't.
export async function savedState(w, state, root = backupsRoot()) {
  const saved = await readLatest(w, root);
  if (!saved) return {};
  const head = line(await git(w, ["rev-parse", "HEAD"]));
  const out = { commitsSaved: state.unpushed > 0 && saved.bundleHead === head };
  if (state.files > 0 && saved.head === head) {
    const dir = await tempDir();
    try {
      out.patchSaved = (await workingTree(w, dir)).tree === saved.tree;
    } finally {
      await dropDir(dir);
    }
  }
  return out;
}

// A patch is only called saved once it rebuilds the same tree. Ignored files stay out.
export async function savePatch(w, root = backupsRoot()) {
  const dir = await tempDir();
  if (!dir) return { error: "could not make a temporary folder" };
  try {
    const head = line(await git(w, ["rev-parse", "HEAD"]));
    const now = await workingTree(w, dir);
    if (now.error) return now;
    const dest = await newBackupDir(w, root);
    if (!dest) return { error: `could not write to ${root}` };
    const file = `${dest}/changes.patch`;
    const diff = await withIndex(w, now.index, ["diff", "--cached", "--binary", "--no-renames", `--output=${file}`, "HEAD"]);
    if (diff.code !== 0) return { error: failure(diff, "could not write the patch") };
    await exec("chmod", ["600", file]);
    const check = `${dir}/check`;
    await withIndex(w, check, ["read-tree", "HEAD"]);
    const applied = await withIndex(w, check, ["apply", "--cached", file]);
    if (applied.code !== 0 || line(await withIndex(w, check, ["write-tree"])) !== now.tree) {
      await dropDir(dest);
      return { error: "the patch didn't rebuild these files, nothing saved" };
    }
    await remember(w, root, { head, tree: now.tree, patch: file });
    return { file };
  } finally {
    await dropDir(dir);
  }
}

// Commits GitHub doesn't have, in a bundle that needs only a clone of the repo to restore.
export async function saveCommits(w, root = backupsRoot()) {
  const head = line(await git(w, ["rev-parse", "HEAD"]));
  const dest = head && await newBackupDir(w, root);
  if (!dest) return { error: `could not write to ${root}` };
  const file = `${dest}/commits.bundle`;
  const made = await git(w, ["bundle", "create", "-q", file, "HEAD", "--not", "--remotes"]);
  if (made.code !== 0) {
    await dropDir(dest);
    return { error: failure(made, "could not write the bundle") };
  }
  await exec("chmod", ["600", file]);
  const heads = await git(w, ["bundle", "list-heads", file]);
  if ((await git(w, ["bundle", "verify", "-q", file])).code !== 0 || !heads.stdout.includes(head)) {
    await dropDir(dest);
    return { error: "the bundle didn't verify, nothing saved" };
  }
  await remember(w, root, { bundleHead: head, bundle: file });
  return { file };
}

// Only a URL whose host is exactly github.com names a GitHub repo.
export function githubRepo(url) {
  const u = (url ?? "").trim();
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(u);
  return m?.[1] ?? null;
}

// A URL can carry a token, so what's shown never has its login. Only inside the real authority:
// in evil.example?@github.com the host is evil.example, and it must stay what's shown.
export const withoutLogin = (text) => String(text ?? "").replace(/(\w+:\/\/)[^/?#\\\s]*@/g, "$1");

// Where a push would really go. Anything but a GitHub repo known to be private counts as public.
export async function pushPlan(w, state) {
  const urls = line(await git(w, ["remote", "get-url", "--push", "--all", "origin"])).split("\n").filter(Boolean);
  if (urls.length > 1) return { error: `origin pushes to ${urls.length} places` };
  const url = urls[0] ?? "";
  const head = line(await git(w, ["rev-parse", "HEAD"]));
  const repo = githubRepo(url);
  const seen = repo ? await exec("gh", ["repo", "view", repo, "--json", "visibility", "-q", ".visibility"]) : null;
  const closed = line(seen ?? { code: 1 }) === "PRIVATE";
  const commits = plural(state.unpushed, "commit"), where = repo ?? (withoutLogin(url) || "an unknown remote");
  return {
    head, sign: JSON.stringify({ head, url, closed, unpushed: state.unpushed }),
    text: closed ? `Pushes ${commits} to private ${where}` : repo ? `Publishes ${commits} to public ${where}` : `Publishes ${commits} to ${where}`,
    label: closed ? "Push" : "Publish",
  };
}

// The commit shown in the question, never forced, with the repo's hooks: a name already taken stops it.
export async function pushBackup(w, head) {
  if (!head) return { error: "could not read its commit" };
  const ref = `refs/heads/backup/${nameOf(w)}`;
  const pushed = await exec("git", ["push", "origin", `${head}:${ref}`], { cwd: w.path });
  if (pushed.code !== 0) return { error: withoutLogin(failure(pushed, "push failed")) };
  const remote = await git(w, ["ls-remote", "origin", ref]);
  if (remote.stdout.split(/\s/)[0] !== head) return { error: "GitHub doesn't show the commit" };
  return { ref: `backup/${nameOf(w)}` };
}

// What deleting would lose, read again each time. `sign` changes if anything does.
export async function deleteCheck(w, root = backupsRoot()) {
  try {
    const inside = (p) => p === w.path || p?.startsWith(`${w.path}/`);
    if (spaces().some((s) => !s.machine && s.folder === w.path)) return { error: "close its space first" };
    const here = panes().filter((p) => inside(p.cwd));
    if (here.some((p) => p.status === "working")) return { error: "an agent is working here" };
    if (here.length) return { error: "open in a terminal" };
    if (await isLocked(w)) return { error: "locked" };
    const state = await treeState(w);
    if (state.unreadable) return { error: "could not check its files" };
    const at = (await touchedAt([w.path])).get(w.path) ?? 0;
    if (!at || Date.now() / 1000 - at < RECENT_AFTER) return { error: "used in the last 7 days" };
    const paths = await ignoredPaths(w);
    if (paths === null) return { error: "could not check its files" };
    const repo = await nestedRepo(w, paths);
    if (repo === null) return { error: "could not check its files" };
    if (repo) return { error: `holds a repo: ${repo}` };
    const head = line(await git(w, ["rev-parse", "HEAD"]));
    const dir = await tempDir();
    let tree;
    try {
      const now = await workingTree(w, dir);
      if (now.error) return { error: now.error };
      tree = now.tree;
    } finally {
      await dropDir(dir);
    }
    const saved = await readLatest(w, root);
    const lost = [
      state.files > 0 && !(saved?.head === head && saved?.tree === tree) && `${plural(state.files, "file")} uncommitted`,
      state.unpushed > 0 && saved?.bundleHead !== head && plural(state.unpushed, "commit"),
      state.ignored.length > 0 && `${state.ignored.length} ignored`,
    ].filter(Boolean);
    const size = sizeOf(await treeSize(w));
    return {
      sign: JSON.stringify({ head, tree, unpushed: state.unpushed, ignored: state.ignored }),
      text: lost.length ? `Delete forever: ${[...lost, size].filter(Boolean).join(", ")}` : `Delete: nothing unsaved, ${size}`,
      ignored: state.ignored,
    };
  } catch {
    return { error: "could not check its files" };
  }
}

// The one forced removal, and only after deleteCheck. GitHub, the main checkout and backups stay.
export async function deleteWorktree(w) {
  const removed = await exec("git", ["-C", w.main, "worktree", "remove", "--force", w.path]);
  if (removed.code !== 0) return failure(removed, "git worktree remove failed");
  if (w.path.includes("/.codex/worktrees/")) await exec("rmdir", [w.path.split("/").slice(0, -1).join("/")]);
  const base = (await baseBranch(w.main)).replace(/^origin\//, "");
  if (w.branch && w.branch !== base) await exec("git", ["-C", w.main, "branch", "-D", w.branch]);
  return null;
}
