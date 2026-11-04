// Sorting worktrees by what removing one would lose, whatever its age.
const RECENT_AFTER = 7 * 86400;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A worktree in use or holding work never goes in a group that offers Remove.
export function groupOf(state, at, now) {
  if (!state || state.unreadable || state.locked || state.files > 0 || state.unpushed > 0) return "work";
  if (!at || now - at < RECENT_AFTER) return "recent";
  // A detached HEAD's commits have no branch of their own to stay on.
  if (state.unique > 0) return state.branch ? "pushed" : "work";
  return "safe";
}

export function whyOf(state) {
  if (!state) return null;
  if (state.unreadable) return "could not check";
  const work = [
    state.files > 0 && `${plural(state.files, "file")} uncommitted`,
    state.unpushed > 0 && `${plural(state.unpushed, "commit")} not pushed`,
  ].filter(Boolean);
  if (work.length) return work.join(" · ");
  if (state.locked) return "locked";
  if (state.unique > 0) return state.branch ? `${plural(state.unique, "commit")} on GitHub` : `${plural(state.unique, "commit")} not in main`;
  return null;
}

export function sizeOf(kb) {
  if (!kb) return "";
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(kb / 1024))} MB`;
}
