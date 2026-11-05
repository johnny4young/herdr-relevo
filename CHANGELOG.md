# Changelog

## 0.6.1 · 2026-11-05

- **Land never merges commits you didn't see.** A card can be minutes old. Land now reads the PR again first: when it has commits newer than the card, nothing is merged, a toast says so and the PRs are read again, instead of showing GitHub's "Head branch was modified".
- **A stuck PR read no longer freezes the list.** A read that never answers stops blocking the next one after 2 minutes, and the Inbox header turns red with "last read failed", the error in its tooltip.
- **A gone prompt cache reads dim.** Only a cache about to expire, under 10 minutes, stands out in `ansi3`.

## 0.6.0 · 2026-11-05

- **Where your tokens go.** `⌥⌘U` opens **Tokens**: output and new context by surface (Claude Desktop, terminal, automatic sessions, Codex), by project, by subagent type and by day, for today, 7, 14 or 30 days and any account. It also shows how much came from conversations cached again after an hour's pause. It reads the transcripts on your Mac with `grep`, `awk` and `dd`, a little at a time, and sends nothing anywhere. The first read of a month of transcripts can take several minutes; later ones only read what was added.
- **Claude Desktop beside Herdr.** Desktop sessions that ask you something or are ready for review get an **In Desktop** section in the Inbox, and the Agents list gets a **Desktop** group with the ones working too. **Open in Desktop** takes you to the session; ✓ marks it addressed like a PR.
- **Alerts outside Herdr.** With Herdr behind another app, its alerts also reach macOS's Notification Center, including an agent that starts asking or finishes. With `terminal-notifier` installed, a click brings Herdr forward on that agent, and its banner goes away once it's answered.
- **Land a PR.** A PR ready to merge gets **Land**: a second click merges it, with the repo's merge method and only at the commit the card showed, follows the workflows the merge starts, and then removes its worktree and closes its resting agents. It removes nothing unless the worktree's HEAD is the merged commit and nothing is uncommitted. A workflow that fails after the merge keeps everything and says which one. A PR still waiting on checks or reviews gets **Land when ready**, through auto-merge.
- **More from a PR card.** **Update branch** for a PR behind its base, **Retry CI** for failed jobs too, your drafts under "▸ N drafts" with **Ready for review**, and "merge conflict" or "behind its base" as reasons.
- **Review only what changed.** The review pane gets **Mark seen**, and sending comments marks it too. **Since I looked** then shows only what changed after that, new files included. Each file has a **Viewed** box that clears itself when the file changes.
- **Settle an agent.** ✓ beside an agent in the list moves it under a folded **Settled** group until it works or asks again. It's the same mark as the Inbox's ✓.
- **Each agent's context.** An agent's row shows its model and context, and while it rests how long its prompt cache lasts, in `ansi3` under 10 minutes: past that, the next message writes the whole context again.
- **A summary on top of the Inbox.** What needs you, reviews, your PRs, PRs ready to merge and today's tokens, in one row.

## 0.5.24 · 2026-11-04

- **A cancelled check isn't a failure.** GitHub reports a PR with a cancelled check as failed. Relevo now shows **CI cancelled** with `⊘`, with no red dot, failure alert or **fix** button, and offers **Retry CI**, which runs the cancelled jobs again. Any real failure on the same PR stays red.
- **Codex's account chip.** A Codex agent labelled `agent.account=codex` shows its chip in the Agents list, never as borrowed from the repo's account.
- **One age per worktree.** A worktree in use shows `used 22m ago` under its name, without repeating the age beside it.

## 0.5.23 · 2026-11-04

- **Agent time today is by project.** Each row is a project and its time. Time with a ticket adds to its project instead of having its own row, and overlaps count once. **Week** keeps its table per ticket, for filling a time tracker.

## 0.5.22 · 2026-11-04

- **Agent time goes to the project.** Time in a worktree or a subfolder now counts for its repo, not for the folder's name, and overlapping agents in one project count once. Time with a ticket keeps its ticket row, with the repo beside it. Stretches already in the ledger keep the name they were saved with.
- **A record of removed worktrees.** **Remove**, **Remove N** and **Delete** add a line to `deletions.log` in the backups folder: when, what the row said, the repo, path, branch and commit. The commit can bring a deleted branch back until git cleans it up.

## 0.5.21 · 2026-11-04

- **A lighter agents list.** It reads Herdr's panes once each time it draws, instead of several times per agent. Those repeated reads are what Herdr 0.1.13 fixed in its own list, where a busy setup could end in "This view could not be re-rendered".
- **Find in a terminal.** Herdr 0.1.13 adds it, but if you merged Relevo's keys into your `keys.json`, it won't turn on by itself: add `"cmd-f": "terminal.search"` to the `terminal` section.

## 0.5.20 · 2026-11-04

- **An agent's PR in its row.** The Agents list shows `#24 ✓ +12 −3` under an agent working on an open PR: its number, CI and size. A click opens the PR. It finds the PR by the agent's commit or branch, so a review worktree with another name counts too.
- **Review a whole branch.** The review pane gets **All changes** beside **Uncommitted**: everything since the branch left its base, without needing a PR.
- **Calmer cards.** An Inbox card keeps its main actions in sight and folds the rest behind `⋯`. The red border now only means an agent is waiting on you; a PR with failing CI keeps its badge and red dot.
- **Easier to read.** Relevo uses two text sizes, 11 and 13, instead of nine, and hierarchy comes from weight and color.

## 0.5.19 · 2026-11-04

- **See which folder an agent belongs to.** Each row in the Agents list gets a small folder icon in the color of its sidebar folder, with the name on hover. If an agent runs somewhere its space's name doesn't say, like a worktree, a second line shows the path, and hovering the row shows it whole.
- **A merged PR doesn't mean you're done there.** A merged worktree used in the last day says `used 22m ago` instead of offering **Remove**, also in **Remove N**. It's checked again when you click.
- **No more long waits on Checking.** Opening "worktrees without a space" while another read was running could leave its rows on Checking for up to 10 minutes. It now reads them right after.

## 0.5.18 · 2026-11-04

- **Read why, whole.** A worktree's reason or error now has its own line under the row, instead of being cut off beside the buttons.
- **See your backups.** The worktrees section shows how much `~/relevo-backups` takes, with **Open**. Nothing is ever deleted from it for you.
- **Fewer wrong repos.** Looking up merged PRs now only trusts a remote whose host is exactly github.com, as pushing a backup already did.

## 0.5.17 · 2026-11-03

- **Do something about a worktree with work.** Its row in "worktrees without a space" gets a `⋯` menu. **Save patch** and **Save commits** keep your changes and commits outside the repo, in `~/relevo-backups`, and only say saved once they're verified. **Push backup** sends commits to a `backup/` branch and warns you when that publishes them. **Delete** removes the worktree and everything in it, saying first what you'd lose. Anything used in the last 7 days, open or locked can't be deleted.
- **Pick the backups folder** in Settings. Existing `config.js` files use `relevo-backups`.

## 0.5.16 · 2026-11-03

- **Know which worktrees can go.** "Worktrees without a space" now sorts them by what removing one would lose: nothing, commits already on GitHub, or your work. Each row says why and how big it is, and only the first two groups offer **Remove**. Ones used in the last 7 days fold under **Recent**.

## 0.5.15 · 2026-11-03

- **Why it's waiting, at a glance.** A blocked agent in the Agents list gets a second line with its reason, like `Run: rm -rf dist · +2 lines`, `Edit: notes.txt` or `Plan to approve`. "While you were away" says the same. You still approve on its card in the Inbox, where the whole command shows.

## 0.5.14 · 2026-11-03

- **See what you're approving.** A permission's card in the Inbox now shows the command, diff or plan, with why the agent wants it. Before, a Claude card only asked "Do you want to proceed?", and a Codex card lost the command's first line. Long lines wrap, and past 8 lines a click shows the rest. If the card can't read all of what's being asked, it offers no answer and sends you to the agent.
- **No more status line as the question.** When an agent waits without choices, its card shows what the agent said last, not the footer under its input box.

## 0.5.13 · 2026-11-03

- **Start where there's room.** `⌥⌘N` starts a new agent on the Claude account with the most quota left, whichever of its 5h and 7d windows is fuller, and a toast says which one it picked.

## 0.5.12 · 2026-11-03

- **While you were away.** Back after ten minutes or more, a card at the top of the Inbox says which agents finished and what they said last, which ones wait for you, what changed on your PRs and how much quota went.
- **Pick up an old session.** `⌥⌘E` lists this repo's past sessions with their title, branch and PR. Type to filter, Enter resumes it with its account, Tab shows every repo.

## 0.5.11 · 2026-11-03

- **Quick replies.** `⌥⌘S`, the ↩ beside an agent, or **Reply** on an Inbox card sends a message or one of your saved replies, like "commit and push". Pick one with ↑/↓ and Enter or its number. Edit them in Settings. Older `config.js` files get three defaults.
- **Your replies, in your order.** The ones you send most come first, and phrases you keep typing to agents in the same context fill the list up to five.
- **Ready to merge.** Your green PRs with nothing to fix fold under one line in the Inbox, so they don't vanish while they wait for you.
- **Merged PRs say so.** A toast tells you when your PR merges. When its worktree is still here, a click opens the Inbox on that row, ready to **Remove**.

## 0.5.10 · 2026-11-02

- **Hand off from where you look.** Click an agent's account chip, or **Continue with…** on a waiting card, to move it to another account.
- **One agent at a time.** A working agent stops first, and nothing starts if it won't. The next agent gets its last turn, and two never edit the same tree.
- **Close when it's safe.** After a handoff, a toast offers to close the previous agent, unless it's in use or its helpers still run.
- **Full accounts can't be picked**, and the next agent only hears about quota if that's why it took over.

## 0.5.9 · 2026-11-02

Needs Herdr 0.1.12 for pins to work.

- **Pins follow you.** Pinned agents now show across Herdr windows and the phone app. Pins you already have move over the next time their agent is listed.
- **Unnamed tabs say what's happening.** The agents list shows what the agent is doing instead of a tab number.
- **Files keeps up.** Files inside a new folder get their mark, and a symlink to a folder opens like a folder.
- **No empty strip.** The space under the agents list in a wide sidebar is gone.

## 0.5.8 · 2026-11-02

- **Quota windows stand alone.** A source missing a window, or whose window ended, no longer hides the one another source has. If your statusline writes the snapshots, write only when the values change: an idle session rewriting old values with a fresh date makes the bars jump.
- **Swift worktrees can go.** Remove refused any worktree with SwiftPM's `.build/checkouts`, since it holds clones. Folders a tool manages no longer count as a repo or as work to keep. A repo elsewhere still stops it, and so does a search that can't finish.

## 0.5.7 · 2026-11-02

- **One answer at a time.** A second click on a card could land its Enter in the next dialog. A send now holds that agent's turn until its dialog has gone, and needs the agent to still be waiting. Clicks on a multiple choice's boxes wait their turn.
- **Only menus it can read.** A numbered list with no cursor is no longer offered as choices. Menus it can't read show no choices and no Reply, so you answer them in the terminal.
- **A rule can't hide a command.** What's above a dialog's edge now counts when comparing it, apart from timers and status lines.
- **Blocked PR agents show up.** An agent waiting in a PR's tab now gets a card and counts in the Inbox.
- **Remove checks again.** Removing a worktree looks again on each click, before any space closes. It stops for uncommitted or hidden files, skipped edits, a repo inside an ignored folder, submodules, a lock, a terminal elsewhere or a working agent.
- **Ignored work is named.** Remove says which ignored files go with the worktree, such as `.env` or `build`, and Remove all leaves those worktrees out. Folders an install brings back, like `node_modules`, don't count.
- **Unsaved edits stay.** Saves, reloads and outside changes that overlap no longer lose edits or drop a request. Another Files tree can't close an editor with unsaved edits, and a deleted file offers Keep mine without Reload.
- **Spinner stops.** A failed first PR scan shows "PRs unavailable" instead of animating forever. Healthy refreshes stay still.
- **Lighter review.** Diffs with no range comments skip that work on each render.
- **Hook can't block an agent.** If the mod moves, the hook now exits cleanly. If you installed it, run `--install` again: `--check` shows `outdated`.

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
