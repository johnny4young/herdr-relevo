# Changelog

## 0.5.6 · 2026-11-02

- **Long and framed dialogs are compared whole.** An indented frame could drop the choices from the comparison, and a rule inside a command or a very long command could hide the lines above it. The check now compares everything up to the dialog's real top edge, and the choices one by one.
- **No screen, no answer.** If the agent's screen can't be read, or it shows a menu that can't be parsed, a reply sends nothing instead of treating it as no menu.

## 0.5.5 · 2026-11-02

- **The check covers the whole dialog.** 0.5.4 compared only the question and choices, so two permissions with the same words and different commands looked alike. It now compares the dialog from its top edge to its last choice, including the command, diff and descriptions.
- **Reply stops if a menu appears.** On a card without choices, a typed reply isn't sent once a menu has appeared, since its Enter would pick an option.
- **The keyboard answers what's drawn.** A choice made by key now checks against the card on screen, like a click.

## 0.5.4 · 2026-11-02

- **Answers only reach the question you saw.** Before sending a choice, Submit or a typed answer, the Inbox reads the agent's screen again. If the question or its choices changed, it sends nothing, says so and shows the new question.
- **A returning agent shows its current question.** Fixes a bug from 0.5.3: an agent that left the list and came back waiting could show its old question, and a click then answered the new one.

## 0.5.3 · 2026-11-02

- **Walk your agents.** `⌘]` and `⌘[` move to the next or previous agent, in the Agents list's order.
- **Keys only where they belong.** Relevo's keys move to a `layout:relevo` section, so they act only while Relevo shows. If yours are under `global`, they keep working until you move them.
- **Cards keep their age.** Reloading the mod no longer resets a card's age or its place in the list.
- **A picture in Settings.** The layout now shows a preview instead of an empty frame.
- **How to update.** The README has an Update section whose commands keep your accounts in `config.js`.

## 0.5.2 · 2026-11-02

- **Mark local work addressed.** ✓ on an uncommitted-work card hides it until its agent works again; addressed ones fold under one line with Undo. A waiting agent always stays in the list.
- **The Inbox follows events.** Local cards update about 2 s after a commit, checkout or stash, and when a shell command ends. The slow fallback scans only run while the window is in front.
- **Git reads leave `.git` alone.** Repeated status and diff reads no longer refresh the index or take a lock.
- **Tests that draw the mods.** The Inbox and every Relevo role now render against a fake Herdr in CI.

## 0.5.1 · 2026-11-01

- **The hook ships with Relevo.** `mods/relevo/hooks/relevo-labels.py` sets the account, ticket, session file and background labels, with `--check`, `--install` and `--uninstall`. Tell your agent to follow `hooks/HOOK.md`.

## 0.5.0 · 2026-11-01

- **Mark a PR addressed.** ✓ on a PR card hides it until the PR has new activity (a comment, review or push); addressed ones fold under one line with Undo.
- **More from a PR's ▾.** Pick any account, run the recommended skill or the two you use most, or open a new session on the PR in its own worktree with the PR checked out. Someone else's fork doesn't get a session, since an agent there could run its code.
- **Review shows the PR's exact code.** Without a checkout it reviews the head GitHub publishes for the PR, so a stale local branch or a fork's branch named like one of yours can't show the wrong code.
- **Background work shows on agents.** An agent with background shells or wakeups shows ⧗ and the count beside its account chip.
- **Merged worktrees ignore forks.** A merged fork PR whose branch is named like one of yours no longer marks your worktree as merged.

## 0.4.1 · 2026-11-01

- **Handoffs keep the conversation.** Between Claude accounts the next one resumes the same session (`--resume --fork-session` from a copy of its file), so it doesn't start cold and re-read the repo. Handoffs to and from Codex start from the note, and Codex's own quota alert offers one too. The old agent is interrupted once the new one starts.
- **Safer handoff copies.** The session label is trusted only as a UUID file in the source account's own projects folder, and the copy never follows a symlink; anything else falls back to the note.

## 0.4.0 · 2026-11-01

- **Checkout selector.** The panel bar's worktree chips become one selector: every checkout of the repo with its uncommitted files, ahead/behind and last use, newest first.
- **Files with actions.** Right-click a file or folder: New file, New folder, Rename, Move to Trash, Reveal in Finder, Copy path and Copy relative path.
- **Edit files.** The Files preview and the file view have an Edit button; ⌘S saves, a dot marks unsaved changes, and a change on disk while you edit asks Reload or Keep mine.
- **Screenshots** of each feature in the README.

## 0.3.0 · 2026-11-01

- **Remove all merged worktrees.** One Confirm removes every merged worktree that is clean, unlocked and has no space.
- **Notes with your answer.** Write a note on a waiting agent's card; it reaches the agent right after you answer.
- **See the preview.** A question's preview shows on its card, so you can choose without opening the agent.
- **What the agent said last.** Uncommitted-work cards quote the agent's last message, so you know whether to review or reply.

## 0.2.0 · 2026-11-01

- **Answer agents from the Inbox.** A waiting agent's question shows with its choices: single, multiple (with Submit) and free text, and a summary of your answers before you send them. Works with Claude Code and Codex (Codex asks in Plan mode).
- **Review a whole PR.** Your PR cards open the PR against its base, even when the branch isn't checked out; comments go to its agent or a new one.
- **Range and file comments** in the review pane, kept until you send them.
- **PR alerts** when CI fails or passes, new review threads arrive, or a PR is approved or gets changes requested.
- **When a quota runs out.** Quota tooltips show when a window hits 100% at the current pace; the handoff offer comes at 95%.
- **Settings.** Configure accounts, contexts, fallback, folders and skills from a dialog instead of editing config.js.
- **The keyboard keeps the selection in view** in a long Inbox.
- CI runs the tests and an undefined-name lint on every push.

## 0.1.0 · 2026-11-01

- First release: per-account quotas, the Inbox of waiting agents, uncommitted work, pull requests (with CI and unresolved-thread badges) and merged worktrees, keyboard navigation, a line-by-line review pane, handoffs between accounts, and agent time per ticket with a weekly view.
