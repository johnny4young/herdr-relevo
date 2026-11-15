// Stale local branches of the clones in ROOT: read, and deleted only the way git allows.
import { exec, home } from "herdr";
import { REPOS_ROOT as ROOT } from "./config.js";
import { GIT_READ } from "./lib/git.js";
import { REFS_FORMAT, checkedOut, deleteArgs, staleBranches } from "./lib/branches.js";
import { baseBranch } from "./worktrees.js";

const CLONES = 'for d in "$1"/*/; do [ ! -d "$d.git" ] || printf "%s\\n" "${d%/}"; done';
const STALE_TTL = 15 * 60 * 1000;
const kept = new Map();

async function staleOf(main, force) {
  const hit = kept.get(main);
  if (hit && !force && Date.now() - hit.at < STALE_TTL) return hit.list;
  const refs = await exec("git", [...GIT_READ, "-C", main, "for-each-ref", REFS_FORMAT, "refs/heads"]);
  const trees = await exec("git", [...GIT_READ, "-C", main, "worktree", "list", "--porcelain"]);
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
  const mains = (await exec("sh", ["-c", CLONES, "sh", `${home()}/${ROOT}`])).stdout.split("\n").filter(Boolean);
  const out = [];
  for (const main of mains) out.push(...await staleOf(main, force));
  return out;
}

// git's own words either way: what it deleted (with the commit, to bring it back) or why it refused.
export async function deleteBranch(b) {
  const r = await exec("git", deleteArgs(b.main, b.name));
  if (r.code !== 0) return { error: r.stderr.trim() || "git branch -d failed" };
  kept.delete(b.main);
  return { said: r.stdout.trim() };
}
