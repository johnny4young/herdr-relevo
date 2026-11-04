// Sorting worktrees by what removing one would lose, whatever its age.
export const RECENT_AFTER = 7 * 86400;
// A merged PR doesn't mean the work there stopped, and an unknown time counts as in use.
export const MERGED_MARGIN = 86400;
export const justUsed = (at, now) => !at || now - at < MERGED_MARGIN;
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A worktree in use or holding work never goes in a group that offers Remove.
export function groupOf(state, at, now) {
  if (!state || state.unreadable || state.locked || state.files > 0 || state.unpushed > 0) return "work";
  if (!at || now - at < RECENT_AFTER) return "recent";
  return state.unique > 0 ? "pushed" : "safe";
}

export function whyOf(state) {
  if (!state) return null;
  if (state.unreadable) return "could not check";
  const work = [
    state.files > 0 && `${plural(state.files, "file")} uncommitted${state.patchSaved ? ", saved" : ""}`,
    state.unpushed > 0 && `${plural(state.unpushed, "commit")} not pushed${state.commitsSaved ? ", saved" : ""}`,
  ].filter(Boolean);
  if (work.length) return work.join(" · ");
  if (state.locked) return "locked";
  if (state.unique > 0) return `${plural(state.unique, "commit")} on GitHub`;
  return null;
}

// Menu of a row with work; a row in use can still be saved, but only an idle one deleted.
export function actionsOf(state, at, now) {
  if (!state || state.unreadable) return [];
  return [
    state.files > 0 && !state.patchSaved && "patch",
    state.unpushed > 0 && !state.commitsSaved && "commits",
    state.unpushed > 0 && "push",
    !state.locked && at && now - at >= RECENT_AFTER && "delete",
  ].filter(Boolean);
}

export function sizeOf(kb) {
  if (!kb) return "";
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(kb / 1024))} MB`;
}
