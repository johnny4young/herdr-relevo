// Stale local branches of the clones in ROOT: read, and deleted only the way git allows.
import { exec, notify } from "herdr";
import { GIT_READ } from "./lib/git.js";
import { REFS_FORMAT, checkedOut, staleBranches } from "./lib/branches.js";
import { baseBranch, clones, deleteLocalBranch } from "./worktrees.js";
import { logRemoval } from "./worktree-actions.js";
import { plural } from "./lib/trees.js";

const STALE_TTL = 15 * 60 * 1000;
// Clones read at once: enough to be quick on many repos without a burst of git processes.
const AT_ONCE = 4;
const kept = new Map();

// One repo's stale branches. `failed` when git could not be read: the last list stands, and nothing is kept.
export async function staleOf(main, force = true) {
  const hit = kept.get(main);
  if (hit && !force && Date.now() - hit.at < STALE_TTL) return { main, list: hit.list };
  const [refs, trees] = await Promise.all([
    exec("git", [...GIT_READ, "-C", main, "for-each-ref", REFS_FORMAT, "refs/heads"]),
    exec("git", [...GIT_READ, "-C", main, "worktree", "list", "--porcelain"]),
  ]);
  // Without the checkouts nothing can be called untouched.
  if (refs.code !== 0 || trees.code !== 0) return { main, list: hit?.list ?? [], failed: true };
  const base = (await baseBranch(main)).replace(/^origin\//, "");
  const skip = checkedOut(trees.stdout);
  for (const name of base ? [base] : ["main", "master"]) skip.add(name);
  const repo = main.split("/").pop();
  const list = staleBranches(refs.stdout, { now: Date.now() / 1000, skip }).map((b) => ({ ...b, main, repo }));
  kept.set(main, { at: Date.now(), list });
  return { main, list };
}

// Every clone, AT_ONCE at a time, in the clones' order: the branches, and the repos that could not be read.
export async function scanStale(force = false) {
  const mains = await clones(), read = new Array(mains.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, mains.length) }, async () => {
    while (next < mains.length) {
      const i = next++;
      read[i] = await staleOf(mains[i], force);
    }
  }));
  return { branches: read.flatMap((r) => r.list), failed: read.filter((r) => r.failed).map((r) => r.main) };
}

// -d first. When git refuses an unmerged branch, `ask` says what -D would lose; only a Confirm with the same tip
// forces it, and the tip goes to deletions.log so it can come back.
export async function deleteBranch(b, sure = null) {
  if (sure) {
    const tip = await tipOf(b);
    if (tip !== sure) return { error: "changed, look again" };
    const r = await deleteLocalBranch(b.main, b.name, true);
    if (r.code !== 0) return { error: firstLine(r.stderr, "git branch -D failed") };
    kept.delete(b.main);
    if (!await logRemoval({ repo: b.repo, path: b.main, branch: b.name }, tip, `Delete branch, ${b.ask ?? "unmerged"}`)) {
      notify({ title: "Deleted, but not written to deletions.log", body: `${b.name} was ${tip}`, level: "warning" });
    }
    return { said: r.stdout.trim() };
  }
  const r = await deleteLocalBranch(b.main, b.name);
  if (r.code === 0) {
    kept.delete(b.main);
    return { said: r.stdout.trim() };
  }
  if (!/not fully merged/.test(r.stderr)) return { error: firstLine(r.stderr, "git branch -d failed") };
  const [tip, base] = await Promise.all([tipOf(b), baseBranch(b.main)]);
  const cherry = tip && base ? await exec("git", [...GIT_READ, "-C", b.main, "cherry", base, tip]) : null;
  if (!cherry || cherry.code !== 0) return { error: firstLine(r.stderr, "git branch -d failed") };
  const only = cherry.stdout.split("\n").filter((l) => l.startsWith("+")).length;
  return { tip, ask: only ? `${plural(only, "commit")} only on this branch` : `its commits are already in ${base.replace(/^origin\//, "")}` };
}

const firstLine = (text, fallback) => text.trim().split("\n")[0] || fallback;
const tipOf = async (b) => {
  const r = await exec("git", [...GIT_READ, "-C", b.main, "rev-parse", "-q", "--verify", `refs/heads/${b.name}`]);
  return r.code === 0 ? r.stdout.trim() : null;
};
