# Changelog

## Unreleased

- **Mark a PR addressed.** ✓ on a PR card hides it until the PR has new activity (a comment, review or push); addressed ones fold under one line with Undo.
- **More from a PR's ▾.** Pick any account, run the recommended skill or the two you use most, or open a new session on the PR in its own worktree with the PR checked out (`gh pr checkout`, forks too).
- **Background work shows on agents.** An agent with background shells or wakeups shows ⧗ and the count beside its account chip.

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
