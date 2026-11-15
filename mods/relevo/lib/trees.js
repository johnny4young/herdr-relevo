import { ago } from "./time.js";

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

const mergedAs = (w) => (w.pr?.number ? `merged #${w.pr.number}` : "merged");
const usedAt = (w) => (w.at ? `used ${ago(w.at)}` : "last use unknown");

// What a worktree holds that removing it would lose, as words that follow "but"; null when nothing.
function workOf(w) {
  if (w.unreadable) return "could not check what is here";
  if (w.unsaved) return "has work that is not saved anywhere";
  if (w.work) return "has work saved in Backups, not on GitHub";
  if (w.dirty) return "has uncommitted changes";
  return w.locked ? "is locked" : null;
}

// Where a worktree reads in Maintenance. "safe" is merged and Remove loses nothing; in use or not read yet is "quiet".
export function laneOf(w, now) {
  if (w.merged) {
    if (w.dirty || w.locked || w.unreadable || w.ignored?.length || w.group === "work") return "look";
    return !w.landed && justUsed(w.at, now) ? "quiet" : "safe";
  }
  return !w.group || w.group === "recent" ? "quiet" : "look";
}

// The one reason a worktree is in its group, in plain words.
export function reasonOf(w, now) {
  const work = workOf(w), ignored = w.ignored?.length > 0;
  if (w.merged) {
    if (work) return `${mergedAs(w)}, but ${work}`;
    if (ignored) return `${mergedAs(w)}, but has files git ignores`;
    return laneOf(w, now) === "quiet" ? `${mergedAs(w)} · ${usedAt(w)}` : mergedAs(w);
  }
  if (!w.group) return "checking";
  if (work) return work.replace(/^(has|is) /, "");
  if (w.group === "recent") return usedAt(w);
  if (w.group === "pushed") return "pushed, not merged";
  return ignored ? "nothing to lose in git, but has files git ignores" : "not merged, nothing to lose";
}

// What a selected row says before anything goes: its facts, then the files git never saw, LOSE_SHOWN at most.
export const LOSE_SHOWN = 5;
export function loseOf(w) {
  const says = [], ignored = w.ignored ?? [], holds = Boolean(w.work || w.dirty || w.unreadable);
  if (w.merged) {
    const when = w.pr?.mergedAt ? ` ${ago(w.pr.mergedAt)}` : "";
    says.push(`${w.pr?.number ? `Merged as #${w.pr.number}${when}` : "Its branch is gone from GitHub, which reads as merged"}${holds ? "." : ", so the code is safe."}`);
  }
  if (w.unreadable) says.push("Its files could not be checked, so nothing here counts as safe.");
  else if (w.work) says.push(`${w.unsaved ? "Not saved anywhere" : "Saved in Backups, not on GitHub"}: ${w.why}.`);
  else if (w.dirty) says.push("It has uncommitted changes.");
  else if (!w.merged && w.group === "pushed") says.push(`${w.why}, not merged. Removing the folder leaves them there.`);
  else if (!w.merged && w.group === "safe") says.push("No changes, and no commits outside the main branch.");
  if (w.locked) says.push("It is locked, so git keeps it.");
  if (w.at) says.push(`Last used ${ago(w.at)}.`);
  if (w.space) says.push("Removing it closes its space.");
  if (ignored.length) says.push(`Removing the folder ${w.merged ? "also " : ""}deletes ${plural(ignored.length, "thing")} git never saw:`);
  return { says, files: ignored.slice(0, LOSE_SHOWN), more: Math.max(0, ignored.length - LOSE_SHOWN) };
}

export const totalKb = (rows) => rows.reduce((sum, w) => sum + (w.kb ?? 0), 0);

// The one question for several rows, saying only what holds for all of them; not ok names the row in the way.
export function bulkPlan(rows, now) {
  const n = rows.length, kb = totalKb(rows), bad = rows.filter((w) => laneOf(w, now) !== "safe");
  if (!n) return { n, kb, ok: false, why: "nothing selected" };
  if (bad.length) {
    const first = `${bad[0].repo} ${bad[0].branch ?? bad[0].name}`;
    return { n, kb, ok: false, why: `${first}${bad.length > 1 ? ` and ${bad.length - 1} more are` : " is"} not safe to remove. Unselect ${bad.length > 1 ? "them" : "it"} first.` };
  }
  const spaces = rows.filter((w) => w.space).length;
  return {
    n, kb, ok: true, title: `Remove ${plural(n, "merged worktree")}?`,
    body: [`Removes ${n === 1 ? "the folder" : "each folder"} and its local branch.`, n === 1 ? "Its work is merged on GitHub." : "Their work is merged on GitHub.",
      spaces ? `${plural(spaces, "space")} ${spaces === 1 ? "closes" : "close"}.` : null,
      "Nothing unsaved is lost. Logged in deletions.log."].filter(Boolean).join(" "),
  };
}
