// Stale local branches of the clones in ROOT: read, and deleted only the way git allows.
import { exec } from "herdr";
import { GIT_READ } from "./lib/git.js";
import { REFS_FORMAT, checkedOut, staleBranches } from "./lib/branches.js";
import { baseBranch, clones, deleteLocalBranch } from "./worktrees.js";

const STALE_TTL = 15 * 60 * 1000;
const kept = new Map();

async function staleOf(main, force) {
  const hit = kept.get(main);
  if (hit && !force && Date.now() - hit.at < STALE_TTL) return hit.list;
  const [refs, trees] = await Promise.all([
    exec("git", [...GIT_READ, "-C", main, "for-each-ref", REFS_FORMAT, "refs/heads"]),
    exec("git", [...GIT_READ, "-C", main, "worktree", "list", "--porcelain"]),
  ]);
  // Without the checkouts nothing can be called untouched.
  if (refs.code !== 0 || trees.code !== 0) return hit?.list ?? [];
  const base = (await baseBranch(main)).replace(/^origin\//, "");
  const skip = checkedOut(trees.stdout);
  for (const name of base ? [base] : ["main", "master"]) skip.add(name);
  const repo = main.split("/").pop();
  const list = staleBranches(refs.stdout, { now: Date.now() / 1000, skip }).map((b) => ({ ...b, main, repo }));
  kept.set(main, { at: Date.now(), list });
  return list;
}

export async function scanStale(force = false) {
  const out = [];
  for (const main of await clones()) out.push(...await staleOf(main, force));
  return out;
}

// Always -d. git's own words either way: what it deleted (with the commit, to bring it back) or why it refused.
export async function deleteBranch(b) {
  const r = await deleteLocalBranch(b.main, b.name);
  if (r.code !== 0) return { error: r.stderr.trim() || "git branch -d failed" };
  kept.delete(b.main);
  return { said: r.stdout.trim() };
}
