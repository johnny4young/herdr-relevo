// Where a run's worktree lives and how it is named; the coordinator makes the path and the token scanner recognizes it.
export const WORKTREES = [".herdr", "worktrees"];
export const RUN_SLUG = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/;

// The run worktree a folder is in (itself or above it), or null.
export function runFolder(cwd) {
  const mark = `/${WORKTREES.join("/")}/`, at = (cwd ?? "").indexOf(mark);
  if (at < 0) return null;
  const [repo, slug] = cwd.slice(at + mark.length).split("/");
  return repo && RUN_SLUG.test(slug ?? "") ? `${cwd.slice(0, at + mark.length)}${repo}/${slug}` : null;
}
