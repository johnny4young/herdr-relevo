// Local branches nobody touched in a while, read from git's own lists.
export const STALE_AFTER = 30 * 86400;

// Branches checked out in the clone or one of its worktrees, from `git worktree list --porcelain`.
export const checkedOut = (porcelain) => new Set(porcelain.split("\n")
  .filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice(18)));

export const REFS_FORMAT = "--format=%(refname:short) %(committerdate:unix) %(upstream:track)";

// Lines of `for-each-ref` in REFS_FORMAT; `skip` holds the default branch and every branch checked out. Oldest first.
export function staleBranches(out, { now, skip = new Set(), after = STALE_AFTER } = {}) {
  return out.split("\n").flatMap((line) => {
    const [name, at, ...track] = line.trim().split(" "), when = Number(at);
    if (!name || !when || skip.has(name) || now - when < after) return [];
    return [{ name, at: when, gone: track.join(" ") === "[gone]" }];
  }).sort((a, b) => a.at - b.at);
}

export const staleReason = (b, now) => [`last commit ${Math.floor((now - b.at) / 86400)} days ago`, b.gone && "gone upstream"]
  .filter(Boolean).join(" · ");

// Never forced: git keeps a branch whose commits are not merged.
export const deleteArgs = (main, name) => ["-C", main, "branch", "-d", "--", name];
