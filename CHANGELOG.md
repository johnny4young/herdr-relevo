# Changelog

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
