# Changelog

## Unreleased

- **A stuck run can try again in place.** A run that used its tries and still has its writer offers **Try again**: its findings show as cards to mark, and one more try goes to the same writer, in the same worktree, with the same reviewer and pull request, carrying the marked findings (all of them if none is marked) and your note. **Prepare a follow-up** of a worktree run now starts from the repository instead of a worktree inside the run's worktree, which started without the run's work, and a fix of a pull request still pushes to it.
- **A run that does not start says why.** When the coordinator refuses a start, the run window shows why with **Start again** and **Cancel start**, and a toast says it wherever you are. **Cancel start** also closes the tab it opened. A prompt or a request for changes holds 16,000 characters instead of 4,000, so a long follow-up or a deep review's findings no longer go over.
- **A run opens one tab until it needs two.** A run opens its writer only, whether it starts from the run window or as a fix from Runs; its reviewer opens when the writing is done and checked, and a trust question it asks then shows in Runs. Run tabs name their role first ("Writer · fix-138-deep-review", "Reviewer · …"), so a cut name still tells them apart.
- **Runs keep their family together.** A fix run started from a deep review sits under it in Runs, indented, and the review lists every run it handed its findings to; older fixes are matched by their pull request. A finished run says when ("3h ago · Nov 17, 16:45") and finished runs read newest first.
- **A start that stalls says why.** While a run starts, the run window shows its steps instead of the form: the one waiting says what on (a trust question, a question in its tab, or not opened yet), with **Open its tab**, **Trust and continue**, **Keep waiting** and **Cancel start**, which removes the empty worktree and its branch.
- **The deep review dialog offers what this machine runs.** Each account's model menu lists the models it used here lately, newest first, then the names its CLI takes; Codex installed but off in Settings shows dimmed with the way to turn it on.
- **Run agents start on new Claude Code.** It asks before adding a folder given with `--add-dir`, and a run's agents are given Relevo's reports folder, so they waited on "Adding a new directory" and the start stalled. Relevo answers that question for its own reports folder only; any other folder still waits for you.
- **Fix with a run starts at once.** From a deep review it no longer opens the run form: the run starts with your usual writer and reviewer and the tests the repository declares, and Runs shows it starting; **Adjust…** opens the form when you want to choose. A run starting reads as steps (worktree, writer, reviewer, tests), each done, going or waiting, and one stopped on a question turns red with **Trust and continue**. The run form is tighter: the repository on one line, accounts as their colored letters with their quota, and Start on the right.
- **The run window keeps drawing when a run is opened in it again**, instead of stopping on "FocusHandle.focus() cannot run during render". **Fix with a run** from the run window closes the deep review before it opens the fix, so the review leaves Needs me.
- **Choose a deep review's reviewers.** **Deep review** opens a dialog with one line per reviewer, up to six (two by default): its account, with its color and a bar of how full its quota is, its model and its effort, each a menu. **+** adds a reviewer, digits set the count, Enter starts, Esc cancels, and "Remember for next time" keeps your choice. Settings › Deep review stays the base default.
- **Codex only where it is installed.** A machine without the `codex` command never offers Codex, whatever `USE_CODEX` says, so a setup with only Claude Code works out of the box.
- **An accepted run commits like you would.** Its commit takes the writer's message, which it now writes in the repository's style (conventional commits like `fix(scope): …` when the repository uses them), or a subject from its summary with its details as the body. It was the run's title with the whole prompt as the body.
- **A task reads at a glance.** Its detail opens on one line of where it stands ("Ready to accept · make test passed · Codex approved"), which for a fix of a deep review also says "· 1 major from the deep review left", in amber, when one is. Then the writer's summary and, for such a fix, "3 of 4 majors handled · 1 left", the ones left, what it handled and the minor notes, one line each. What it changed and who did what are always in view: the files with **Review** (`d`), which opens the change in the review pane, then one line per step. Anything still open, a finding left by the deep review or one the run's reviewer found, has **Ask to fix**, which marks it "✓ To fix" (a second click unmarks it), and **Ask to fix all (N)** marks every one of its section. Marked findings show as "3 to fix" with an optional note, **Send feedback** and **Clear**; only Send writes the request, with each finding's file, problem, fix, proof and who found it, to the writer as another try, or as a follow-up when no tries are left. A deep review shows its majors and folds its minor notes. A fix of a pull request is accepted and pushed in one click. Two deep reviews of one PR name the commit each read.
- **Runs you can tidy.** A click on a run selects it and shows Edit, Close and Plan (`e`, `c`, `p`); a second click or Enter opens it. A closed run offers **Archive** (`a`) and **Delete**, which also removes its worktrees unless one has uncommitted work, and older finished runs offer **Archive all**. Runs closed over a week ago archive themselves.
- **A fix reads against its deep review.** A run started from a deep review shows, per finding, what it did: its writer's verdict, or Changed when its report or its diff touched that finding's file, or Not touched. The deep review links to its fix run and marks each card with that outcome. **Fix with a run** and **Post as draft review** close the deep review, so it leaves Needs me. A finished run offers **Close** on its row, which files it under older finished runs, and try lines read "1st try".
- **A run's agents build what they change.** They start in Claude Code's auto mode, in their own worktree, without the OS sandbox, which blocked builds that need the network or a cache outside the checkout (SwiftPM, a first `npm install`). `RUN_SANDBOX = true` in `config.js` turns the sandbox back on. A writer that changed the code but could not run its tests no longer stops the run: the coordinator runs the tests and the reviewer reviews.
- **Codex can be off.** Settings › Codex › Off (`USE_CODEX = false`) keeps Codex out of every account list and every default: runs, second opinions, deep reviews, handoffs, the status bar and the sidebar. A run that last used Codex picks a Claude account instead.
- **Agents go when their part is over.** A deep review's reviewers close their tabs once they report, and **Done** removes the review's worktrees. A run in its own worktree closes its writer and reviewer once it is accepted or cancelled. An agent that is working stays, and so do agents a run borrowed from your sessions.
- **A fix run answers every finding.** A run started with **Fix with a run** from a deep review gives each finding a verdict, Fixed, False positive (with the code that shows it), Won't fix (with why) or Needs your call, and its summary groups them with what needs you first.
- **Runs read like a report.** Before you accept shows the reviewer's findings as cards (level, file, problem, fix), then what nobody checked, folded and once each; a writer's note that a passing check disproved and a review older than the latest writing are left out. A stuck task opens on why and its way on, the run window's next step names the buttons it shows, and an error is one line with the rest on hover. Chips read "2nd try (last)" and "3 attachments", Activity and the log show agents by name and times as "3m ago", test output is a monospace block ending where it failed, and test commands are typed as `npm test; make lint` instead of JSON.
- **Deep review a pull request.** A PR of yours offers **Deep review**: the reviewers in Settings › Deep review (by default two Claude Code sessions on the repo's account: Opus and Sonnet, both at high effort; Codex is one choice among the accounts) each review the whole PR against its base in a worktree of its exact head. The repository's tests run once and every reviewer gets their results and the PR's checks on GitHub; missing evidence goes in their notes instead of stopping them. In Runs a deep review is one row and one page: each reviewer's verdict, a line on what to do next, then the findings by level with their file and line (a click opens it) and the fix. What both reviewers found, on the same or a nearby line of a file or in much the same words, is one finding marked "Both". What nobody checked stays folded, and **Done** closes every reviewer's part. **Post as draft review** puts them on GitHub as a pending review with a comment on each line, **Fix with a run** fixes every blocker and major, and **Done** closes it. A reviewer whose account is past 90% moves to the one with the most left; Codex past it sits out. The ▾ beside it runs the review skills you type most (`/code-review`, `/code-review-pr-fix` and the like) on the PR.
- **A review that asks nothing stays out of Needs me.** A comment-only review after your last commit read "review from devin-ai-integration, copilot" even when it said "No issues found" and left no thread, so a PR that only waited for an approval sat in Needs me while its twin sat in Ready. A comment-only review now counts while the PR has unresolved threads; changes requested always count.

## 0.9.0 · 2026-11-17

- **Land shows it is landing.** After **Confirm land** the card stayed as it was while GitHub checked and merged, and the PR card lingered after the merge. Now the PR turns at once into a landing card, "Landing…" then "Merging…", with no second copy of the PR. A toast says "Merged" as soon as GitHub has merged it, and the landed card stays in Now for a minute before going to Maintenance. A refused merge brings the PR card back and says why.
- **Review on PRs you were asked to review.** A PR waiting on your review offered only its skill and Open PR; **Review** (`r`), the whole PR line by line in the review pane, was left out exactly there. It now shows on every PR whose repo is cloned here.
- **A skill starts on an account with quota left.** **resolve conflicts** and the other PR skills moved off the repo's account only once it was at 100%, so at 98% they started on an account about to stop. From 90% of either window they start on the fallback account with the most left, and the button's tip says why ("Personal is at 98% (5h) — using Team").
- **The review pane colors code.** Diff lines show keywords, strings, numbers, calls, types and comments in the Files editor's colors, over the same green and red tints. It knows JS and TypeScript, Go, Swift, Rust, Python, shell, C-like languages (C, Java, Kotlin, C#), CSS, JSON, YAML and SQL; other files and lines over 400 characters stay plain.
- **Review opens on the changes.** An agent card whose work was committed since it was read opened an empty review ("No uncommitted changes") and needed a click on **All changes**. With nothing uncommitted, the review now opens on the branch's changes against its base, and **Review** reads the checkout again so the card catches up. Picking **Uncommitted** by hand still shows it, empty or not.
- **Spaces holds up when folders move.** A folder whose path starts with `~` opens its new spaces again; Herdr took the `~` literally and failed with "cannot start /bin/zsh". A folder path or repo that was moved or deleted says so instead of failing in Herdr, and a space whose folder is gone reads "folder gone" instead of its old branch. A folders file that can't be read (bad JSON, no permission) is never saved over, a save that fails says why, and a corrupt stored value no longer breaks the sidebar.
- **`doctor` says what an update leaves to you.** It warns while the space-folders mod is still installed, since Spaces replaces it with the same folders, and its hook warning gives the command that fixes it. The README's update section is the one way to update, including from `live-relevo.mjs` installs, which left every mod but `relevo` behind.

## 0.8.0 · 2026-11-16

- **A run's Claude writer stops asking for each command.** Its Bash already runs in the OS sandbox with no way out (`allowUnsandboxedCommands: false`), so `autoAllowBashIfSandboxed` is on for it: `npm test`, `ls` and the like run without a prompt, and anything the sandbox blocks still fails. Your own Claude settings don't change.
- **Runs say it right.** A run whose tasks were all cancelled reads "cancelled" instead of "needs a plan before agents start". A second opinion's cost line counts its review ("1 review") instead of "0 attempts". The review pane opened on a run's change no longer offers to send comments to an agent that isn't there.
- **Planning stays out of the way.** A run's Edit dialog shows its Brief; Outcomes and Ownership (steps, owner, priority, lead) appear behind **Planning…**, or straight away for a run that uses them. The run window shows saved setups and "Wait for earlier tasks" only when there is one to use, and offers the previous setup only after you move away from it. Relevo counts on this machine how often each part of Runs is opened, to keep what is used and drop what is not.
- **Accepting a run opens its draft pull request.** In a run of its own worktree, **Accept and open draft PR** commits, pushes the run branch and opens a draft PR described by the run: the expected outcome, what changed, the checks, the review and what nobody verified. Without an origin, or if `gh` fails, the commit stays and the reason shows. `RUN_DRAFT_PR = false` in `config.js` keeps it to the commit.
- **Fix a pull request with a run.** A PR of yours with failing CI, changes requested or unresolved comments offers **Fix with a run** in Reviews: the prompt is written from GitHub (failing checks, and each unresolved comment with its file and line), the run starts on a copy of the PR's branch, one agent fixes, another reviews, and after you accept **Push to <branch>** adds the commit to the pull request. The push is never forced.
- **A second opinion on any agent's work.** On an agent's row in Reviews with uncommitted work, **Second opinion** opens a reviewer of another provider beside it, runs the repository's tests on the work as it is and sends the reviewer the diff. The verdict, with failing tests as evidence, waits for you in Runs; the agent whose work it is hears nothing unless you ask for changes.
- **A new run fills in its own setup.** Its tests start as what the repository declares (the `test` script of `package.json` with npm, pnpm, yarn or bun, `go test ./...`, `cargo test`, `pytest`, `make test`), until you pick others. The agents you used last are kept only while their accounts have quota. Opened from a run's worktree, a new run points at the repository it came from, not inside the other run. The setup line names the tests: "app · own worktree · Team → Codex · npm test".
- **Runs start without getting stuck.** When a new run's agents stop on "trust this folder", Runs says so under Needs me, with **Trust and continue**, wherever you are; before, the note sat in the run window, left behind in the space you started from. A Claude writer writes its progress and report without asking. A Claude reviewer starts without your hooks, and a Codex reviewer never stops to ask: what your hooks or instructions start outside its sandbox fails and the review goes on.
- **A run says which tests ran.** The Tests step of a task names the command and, when its runner prints it (node --test, Jest, Vitest, Mocha, pytest), how many tests passed: "npm test passed · 3 tests" instead of "1 of 1 passed", which counted commands and read like tests. A failure names the command that failed, and several commands are counted as checks.
- **See a run's code in Runs.** A task of a run in its own worktree lists the files it changed with their added and removed lines, under who did what. **See the diff** (`d`), now beside Accept while the result waits on you, or a click on a file opens that change in the review pane beside the panel: exactly what the reviewer saw, or what you accepted. It used to open the run window, where the diff was one more click away.
- **History no longer fills up.** A full Runs queue (200 tasks) archives finished tasks idle for a week before it takes a new one, as **Archive older than 7 days** does by hand, instead of refusing. The goals file keeps its newest thousand saves instead of refusing every save once it had a thousand. An install keeps the ten newest backups of what it replaced; it had kept every one.
- **The Runs coordinator rests when idle.** With nothing to do for ten minutes it exits and its terminal goes with it; a command that leaves it work, or the Inbox's once-a-minute check while a run is open, starts it again. A watch on an agent's events that ends (the terminal restarted) is opened again instead of leaving the coordinator deaf to that agent. Installing an update of the runs code stops an idle coordinator so the next run uses the new version, and leaves a busy one to finish.
- **Runs say why a task waits.** A queued task no longer just reads "not started" or "waits for its agent": its row and its window say "waits for a free slot: 2 tasks run at once", "waits for “Fix search”, which works in the same checkout", "waits for Luna, which works on “Fix search”" or "waits for Luna to be free".
- **Tokens holds less in memory.** Between reads the token scanner keeps only the saved list of each day's message ids, not a set of every id from the last 31 days (about 8 MB here); a read builds the set of a day only when a message from that day comes in.
- **Runs fixes.** A reviewer that sits on a prompt is waited for instead of blocking the task and costing it an implementation round. A change longer than about 1,500 lines reaches the reviewer cut short instead of as "Could not read the diff". Closing the laptop no longer times out running attempts. Two cancelled tasks no longer stop every other run from starting, and an attempt whose agent's tab is gone can be reconciled. Runs keeps loading once its saved state passes 1 MiB. A finished run's worktree that can't be read says so, with **Read again**, instead of "checking…" for good.
- **Inbox and Spaces fixes.** An agent in a folder that was deleted no longer freezes every agent card. A reply left open after its question was answered in the terminal lets go of the keyboard. "close N" in Spaces disarms after four seconds or when the quiet spaces change, and a drag let go outside the list ends when the pointer leaves it.
- **Smoother lists.** Reviews does its per-PR work once per draw instead of once per row (a list of 150 PRs read the run sources 150 times on every key press), and a closed row builds only the button it shows. Typing in the run window saves the draft at most once a second instead of on every key, and closing or creating still saves at once. The agents list reads its accounts once per draw and redraws once per row the pointer crosses, the tab bar reads the panes once, and Spaces reads its colors and PR counts once. The Files tree draws only the rows in view, and a review of a huge branch lists its first 200 files and counts the rest.
- **Less work in the background.** Spaces no longer reads every repo's git in the same second: the once-a-minute look takes two places per tick, at most four at once, and a space quiet for over a day is looked at every five minutes. It forgets the folders a space's terminal left and gives back watches of repos no longer shown. The review pane reads the open file's diff again only when the file changed. A queued auto-merge is asked about every two minutes once it is a few minutes old. Claude Desktop sessions are kept as the few fields a row needs instead of whole files (about 28 MB less here), and the "viewed" marks keep the newest forty reviews.
- **The review pane never shows one file's diff under another's name.** A slow diff for a file you left is dropped when it arrives.
- **Tokens saves again.** Herdr writes files of at most 1 MiB, and the token scanner's files had grown past it, so since then nothing was saved and every start read weeks of transcripts again. The scanner now keeps its offsets in eight parts and each day's message ids in its own file, picks up the older files, and says "Not saved" in Tokens if a save fails. A transcript listing that fails no longer makes the next read start over.
- **Runs survive a lost coordinator.** A coordinator killed with `hc kill` now stops cleanly. A lock left by a dead coordinator, or one whose number went to another program, no longer blocks a start or makes Pause wait 20 seconds. While a run is open, the Inbox checks once a minute and starts a coordinator again if none is alive.
- **Calmer lists.** Spaces lists a space's commands that run, listen on a port or failed, and leaves out a resting shell, which Maintenance still tidies. In Agents, a row that waits on you keeps its first line for the reason: its age and ticket move to the line below until you select it. The Agents section is called **Needs me**, as in Reviews and Runs.
- **Spaces starts open.** Every space shows its terminals and servers, not only the one you are in, and the "N quiet for over a day" line and the "no space" rows start open too. A chevron still folds one, and it stays folded.
- **Agents by state again, everything shown.** The priority view has one section per Herdr state, **Needs me**, **Done**, **Working** and **Idle**, each with its count and colored like its state. Nothing folds on its own: every working and idle agent is listed, and Settled sits last, open. Claude Desktop sessions and Claude Code in other terminals join the section of their state. Spaces no longer lists agents or Claude sessions; it shows terminals and servers, and a repo gets a "no space" row only for a terminal or a server.
- **Pictures of the new left bar.** The README shows Spaces by folder beside the Agents queue, and the preview shows the left bar as it is now, Spaces above the queue, both drawn from the mods with demo data.
- **Terminals live in Spaces now.** The Terminals tab is gone: every terminal, its port and its actions show under its repo in Spaces, and Maintenance still lists the ones to tidy. The panel's tabs are Reviews and Runs again, and Issues is back on `⌥⌘5`. Your `keys.json` keeps the key you had until you change it: set `cmd-alt-5` to `relevo.panel-issues`.
- **Agents is a queue by turn.** In the priority view the list reads top to bottom as what to do next: **Needs me** (what asks), **Came back** (a result you have not looked at, its name in bold until you do), then what works on one line, "2 working · billing · api", that opens on a click. Idle agents leave the list and live under their repo in Spaces; "3 resting in their spaces" opens them. Claude Desktop sessions and Claude Code in other terminals join the queue by their turn instead of separate groups. Each row that waits on you carries one dim line with its branch, its PR and its context once past 80%.
- **Each repo's PRs, and quiet spaces out of the way.** A space's row shows how many of its PRs are open in Reviews, in red when one needs you; a click opens Reviews filtered to that repo. Spaces with nothing running, asking, changed or listening for over a day fold into one line at the end of their folder, "3 quiet for over a day", which opens to show them and offers **close 3** on a second click. Nothing is ever closed on its own, and `⌃1`…`⌃9` still count the rows you see.
- **Everything alive under its repo.** The space you are in opens in the Spaces list to show what runs in that repo, wherever it runs: its agents with what they need, its Claude Desktop sessions and Claude Code in other terminals, each terminal with its port (a click on the port opens it; Restart, Stop and Close on hover, Close asking for a second click), and servers started in other apps, like "vite in Ghostty :5173". Other spaces show their port and open with their chevron. A repo with something alive but no space shows as a "no space" row in its folder, with `+` to open a space there.
- **Spaces by folder, one row per repo.** The spaces list is Relevo's own now: spaces grouped by folder (your account contexts, plus any folder you add with the folder button, with its name, color, where its new spaces start and which repos it collects), each repo one row with its branch when it is not main, `↑`/`↓` against its upstream, how many files changed and the mark of its most urgent agent. A worktree sits under its checkout. Drag a space onto a folder to put it there; right-click a folder to edit or delete it. The spaces' order follows the list, so `⌃1`…`⌃9` go to the row you see. Your existing folders carry over, and the space-folders mod is no longer needed.
- **Run again types only into the shell.** After stopping a tab's command, Run again waits until its shell is back in front; if the program does not stop, it types nothing and says so. A command with control characters is not offered to run again.
- **Terminals read a tab's command.** A tab opened with a command runs it in a shell that stays; Terminals now shows that command ("node fail.mjs") with "ended" once its shell is back, and **Run again** types it into the same shell, stopping it first when it still runs.
- **The panel tabs fit.** The tab bar is wide enough for Reviews with its count, Runs and Terminals; before, Reviews and Terminals were cut at both ends.
- **Maintenance tidies terminals too.** A Terminals to tidy group lists a command that failed (with **Restart**), the finished ones in one row (**Close N**), what runs with no pane for over an hour (**Show**) and shells idle over a day (**Close**); `d` closes one when pressed twice, as it removes a worktree.
- **Terminals.** A third tab in the panel, beside Reviews and Runs (`⌥⌘5`; Issues moves to `⌥⌘6`), lists every terminal that is not an agent, by space, then the ones running in the background, shells idle over a day and the finished ones. Each says what runs in it and the port it listens on; a selected one shows its last lines, with Open, Peek, Open its port, Restart, Stop, To background and Close (press `x` twice).
- **The README's pictures redraw from the code.** `node scripts/shots/readme.mjs` renders the preview and the README pictures from the mods with demo data (headless Chrome), and a test keeps every scene drawing. `scripts/shots/README.md` says how to add a scene.
- **New pictures.** The preview and the README's pictures of Now, answering an agent, While you were away, the review pane, account usage, a PR's checks, Maintenance and Runs are drawn from Relevo's own code with demo data, so they show the redesign; the README also covers Claude Desktop detail and the Elsewhere group.
- **`doctor` says when the install is behind.** Run from a checkout, it now compares the installed files with the checkout's and warns "the install is behind this checkout: N files differ", even when both carry the same version, as after merging work that has no release yet.
- **Now reads calmer, and Tab is always in sight.** Rows that need you keep their red disc and red words, but only the open row is shaded, so a long Needs me list no longer turns pink. The key bar keeps `tab` and `esc` at the right with `?`, which now reads "? keys", so switching views shows even in the default 380 px panel.
- **The status bar keeps its line under the accounts.** The account usage at the right of the status bar now draws the same top line and background as the workspace status beside it, and an account near its limit is tinted inside the bar instead of over the line.
- **Claude in other terminals shows up too.** A Claude Code session started in Terminal, iTerm, VS Code, Ghostty or any terminal outside Herdr appears in the agents list under **Elsewhere**, with the app's name, what it is doing, what it asks or its last words; a click opens its last message and **Show <app>** brings that app forward. The hook notes each such session in a small local file and removes it when the session ends; Claude Desktop sessions and scripts are left out. Update the installed mod for the hook to start noting them.
- **Read what a Claude Desktop session is doing without leaving Herdr.** The group is called Claude Desktop, and each session reads like an agent: what it is doing now ("editing ui.js", "Run the tests"), the question it asks, or its last words. A click opens its last message and its title right in the list, with **Open in Claude Desktop**; the selected Reviews row shows the last message too. Relevo reads only the end of the session's local transcript, and only when it changed.
- **Reviews opens on Now.** The Reviews tab, its shortcut and the command always land on Now; Maintenance is one `Tab` away, and `Tab` again comes back. `m` still goes to Maintenance, and `n` starts a new run from either view.
- **The way back stays in a narrow key bar.** When a list's keys do not fit, whole keys from the end hide instead of being cut mid-word, and Esc stays at the right next to `?`. In an open task, Ask for changes reads "r changes" in the bar.
- **Now says when nothing needs you, and what it could not read.** With nothing waiting, Now shows a check, "Nothing needs you", what is still in flight, and **m** Maintenance and **n** New run (in Now, **n** always starts a run). The first read shows what has been read and grey rows where pull requests will be. A source that failed (GitHub, agents, runs) is a row under Could not read that says how old its data is, with **Retry** on **r** or Enter. While you were away is a group of normal rows with Dismiss. At the 280 px minimum the legend reads "Me · Flight · Ready", rows drop the age and a row's action becomes a chevron.
- **How to read Relevo.** The README opens with "Whose turn is it?": the four groups, how a row reads, the keys that cover most of the work and a picture of a row, a run, the three levels and the symbols.
- **Compare attempts, see what a run cost, accept several results.** An open run shows one line of cost under its summary: agent minutes and tokens against the run's caps (red at the cap, never a stop), attempts, tests passed and pull requests shipped, with **Pause automation**. A selected task lists its attempts, and **C** on one written more than once compares them side by side (what the reviewer said, tests, files changed, time, tokens, your note) with **See what changed between them**. **x** selects results that wait on you, **X** every one of the same repository, and **Enter** accepts them together; when one is not approved or fails its tests, the first Enter arms and the second accepts. An accepted or cancelled task offers **Re-run with changes…**, and **Saved setups** opens in the Runs list with **Start** and remove on each.
- **A run opens in the panel.** Runs lists each run as one row that says what it is doing or wants now ("3 results wait for your review", "stuck: the reviewer rejected it twice") and what it shipped ("2 pull requests merged: #38, #42"), grouped Needs me, In flight, Ready and Not started. Enter or a click opens the run right there with its tasks; a stuck task says why in the reviewer's words and offers **Prepare a follow-up**. Enter on a task shows who did what and the decision: **A** then Enter accepts, **R** asks for changes, **D** opens the diff. `j`/`k` move, Esc goes back, `n` starts a run. The run window stays for planning a run and for a task's diff, evidence and activity.
- **Keys you can see.** Every list ends with the keys that work there. `j`/`k` move, `g g` and `G` jump to the top and bottom, and on a selected row `r` reviews, `o` opens, `a` marks addressed (`u` undoes), `l` lands a ready PR; the row shows each key beside its button. `/` filters Now. In the review pane, `c` comments, `v` marks viewed and `[`/`]` move between files. The `?` sheet lists them all.
- **Maintenance is for cleaning up.** It opens with three counts, Safe to remove, Needs a look and Old, and every worktree is one row: its repo, its branch, the one reason it is there ("merged #38", "merged, but has files git ignores", "work that is not saved anywhere") and its size on disk. Safe to remove shows how much space the group takes. Select a row that needs a look and it says what removing it would lose, naming up to five files git never saw. `x` selects a worktree and `X` every safe one (merged ones only); `d` asks once ("Remove 3 merged worktrees?") and then removes each with the same checks and log as before, saying which ones stayed and why. Old also lists local branches nobody touched in 30 days, with **Delete branch** (`git branch -d`, so git keeps one that is not merged). In a narrow panel the legend keeps glyphs and counts and rows drop their size.
- **A selected PR says which check failed.** Open a PR row and it names the checks that failed, are running or were cancelled, lists the ones that passed with one box per check, and shows how many files changed, whether anyone reviewed it yet and when it was opened, without going to GitHub.
- **Agents at a glance.** Each agent in the sidebar is one line: a mark for whose turn it is (a red disc needs me, a spinner is working, a check has finished), its name and what it is doing or needs, such as "writing #43" or the question it waits on. The agent you are on opens a second line with its PR, model, context and cache. The groups are Needs me, In flight and Idle, each with a count, and a long Idle group shows three and folds the rest. The "Needs me" pill is gone from the rows.
- **Runs tell you when a result is ready.** A result that comes to wait on you posts "Result ready" with the task and the reviewer's verdict; a click opens Reviews with that result selected. Accepting several at once posts "Batch accepted" with how many and their repository, and its click opens the run.
- **Reviews: Now and Maintenance.** Reviews opens on **Now**, grouped by whose turn it is: Needs me, In flight and Ready, with their counts as a legend and how long ago PRs were read. What can wait moved to **Maintenance**: PRs older than 45 days, worktrees, everything you marked addressed or landed (each with Undo) and agent time. `m` and `n` switch views. The Reviews badge is now exactly the Needs me count.
- **The Inbox reads as rows: whose turn, what, why.** Every item is one line that starts with who holds it (a red disc when it needs you, the spinner while agents or CI work, a check when one key finishes it), then what it is, the one reason it is here, its age and its one action. Click a row, or move to it with the arrow keys, and it opens in place with its details and every other action; Esc closes it. A waiting agent always shows its question, the command it asks about and its numbered answers. A PR with failing CI or requested changes is now marked as needing you, like an agent that asks.
- **Accounts say what happens next.** The usage popup shows each account's 5h and weekly window as a bar with its reset time, says when one will be full within the hour ("full in 9 min at this pace"), and offers **Continue with…** in place of **Start here** for an account at 95% with an agent on it. The handoff popup shows how much room each account has and whether it continues the same conversation or starts from a note. In both, the number keys pick a row, and `R` refreshes the usage popup. In the status bar an account over 80% is tinted and shows when it resets, an old reading shows its age, and a narrow bar keeps only chips and rings.
- **Plain words in Runs.** A round is now an attempt ("attempt 2 of 3"), checks are tests ("tests 3 of 3 passed"), Blocked is Stuck with **See why**, Request changes is Ask for changes, Ready for your review and the Needs you list are Needs me, and the roles read "Writes it" and "Reviews it". Stored fields and states are unchanged.
- **One set of glyphs.** Folds, refresh, more, check boxes and menu arrows are drawn from 28 icons in `mods/relevo/icons/` instead of text characters, so they line up and take the theme colour.
- **A clearer review pane.** A file shows its folder dimmed and its name bright, with a tag for its comment count, **new** on a file the change adds and squares for how much was added and removed. A commented line keeps its number, with a comment icon beside it. Each saved comment sits under its lines as a box, the open file's comments are listed above the footer with a × that deletes just that one, and `⌘↵` sends the comments to the agent like **Send to agent**; in an open comment it saves the comment.

## 0.7.3 · 2026-11-14

- **A permission longer than the screen shows whole.** With the optional hook installed, a command or a plan that doesn't fit the agent's screen shows complete in its Inbox card and can be answered there, when everything the screen still shows of it matches what the hook noted. Before, the card said "Can't read all of what this asks. Open the agent." Run `bash ~/.config/herdr-app/mods/relevo/hooks/relevo-labels.sh --install` once to add the new event to each account; without it everything works as before.
- **A long question reads whole.** An agent's own question of three lines or more showed its first line as if it were a command to approve, and each line was cut off. The card now shows the whole paragraph, wrapped.
- **A run says how it is going.** The implementing agent writes what it is doing, its percent done and its time left, and the run shows it instead of "Awaiting implementation report".
- **What nobody verified shows where you accept.** A result waiting on you lists, on its Summary beside Accept, the reviewer's findings below the bar and what either agent could not run or prove. The full reports stay in Result.
- **Review findings have levels.** A reviewer lists blocker, major and minor findings. Only major or above sends the work back; minor ones reach you as notes, with what the reviewer could not run or prove. `RUN_MUST_FIX` in `config.js` moves the bar.
- **What run agents are told is in two files.** `runtime/roles/executor.md` and `reviewer.md` hold the words; the coordinator fills them in.
- **Run checks find your tools.** The coordinator ran checks with the Herdr core's PATH, where Node from fnm or nvm isn't, so `node --test` failed to start, the implementer was sent back for nothing and the run blocked once its rounds were spent. Checks now run with your login shell's PATH, and a check that can't start blocks the run with what to fix instead of using a round.
- **The run window works with Node from fnm or nvm.** Every action in a run (Accept, Request changes, starting a run) ran `node` with the Herdr app's PATH and failed with "cannot run node". The installer records the node it ran with in `relevo-install/node`, Runs use it, and `doctor` says when it's gone.
- **The reviewer sees the change.** It has no shell, so it reviewed only the files it read. Its prompt now carries the diff against the run's base and the new files.
- **Settings keeps what it doesn't edit.** Saving Settings rewrote `config.js` with only its own fields, dropping `RUN_CODEX_MODEL` and `RUN_MUST_FIX`. Every other export is now written back as it was.
- **A run's git work is safe from its agents.** Relevo reads a run worktree through its own folder in the base repository, so a rewritten `.git` file is ignored, and no filter, diff program or nested repository in the worktree can make it run a program. A run's commit leaves submodules and repositories an agent made as the base has them; the reviewer still sees a submodule pointer that moved.
- **Agents start clean.** An agent Relevo starts no longer takes a parent Claude session's account folder or child-session marker, which a Herdr core started from inside Claude Code would pass on.
- **An installer.** `./install.sh` installs or updates Relevo and keeps the files you changed, with the new version beside them as `.new`. `node scripts/relevo.mjs doctor` checks the install and the programs it needs; `uninstall` removes it. `--dry-run` shows what would change.

## 0.7.2 · 2026-11-12

- **A PR you just opened stays in sight.** For its first day, a PR of yours shows under **YOUR PRS** as "new, CI passed", "new, CI running" or "new", even when it only waits for the merge. It stays out of the badge count. Before, one with green CI went straight into "▸ N ready to merge" and one with CI still running showed nowhere.

## 0.7.1 · 2026-11-11

- **Clear what's done.** A result or decision under **Ready for you** has a ✓ that hides it until the task returns a new revision or the question changes. Nothing is accepted. Hidden ones fold under "▸ N addressed" with **Undo**.
- **Close a run.** **Close** on a run asks first, cancels its open tasks and closes it. A pending decision stays in its history as unresolved. Closed runs fold under "▸ N closed runs". The worktrees of cancelled tasks stay; remove them from the run window.
- **A key for Runs.** ⌘⌥3 opens Reviews, ⌘⌥4 Runs and ⌘⌥5 Issues. Notifications open Reviews. Merge the three lines from `keys.json` into yours.

## 0.7.0 · 2026-11-11

- **Runs: hand a task to two agents and decide on the result.** The panel now has two views, **Reviews** and **Runs**. **+ Run** takes a prompt; one agent implements, your checks run, a second agent reviews, and the result waits for you under **Ready for you** with its agents, round, checks, verdict and age. Accept with **A** then Enter, ask for changes with **R**, or defer. Rounds, minutes and concurrency are bounded, and nothing is sent twice: a delivery Relevo cannot confirm waits for you to reconcile it.
- **Each run in its own worktree.** **Start** creates `run/<slug>` under `~/.herdr/worktrees`, copies the files your repo lists in `.worktreeinclude`, and opens the implementer and reviewer you picked in two tabs. Accounts at 100% are skipped. **Existing sessions** uses agents you already have open instead.
- **Accepting commits what was reviewed.** Acceptance commits exactly the tree the reviewer saw to the run branch, without hooks; anything changed afterwards stays uncommitted. From there: **Open draft PR**, **Remove worktree** (a branch with commits stays), or **Commit accepted changes** if the commit did not land. A cancelled run offers **Discard worktree**.
- **Accept several at once.** **Review a batch** previews and accepts several results of one repository, and commits each run to its own branch.
- **Run agents stay in their checkout.** Codex runs with `workspace-write`. Claude runs Bash in the system sandbox and cannot edit Relevo's state, locks, mods or settings. Both can write their report and nothing else outside the worktree. Codex's "Update available" prompt is skipped when it holds up a run.
- **The run window.** A run opens as a pane beside the work: status chips, the agent's summary as markdown, the diff with **Back to decision**, evidence, activity and searchable shortcuts (**?**). Command-Enter submits the prompt and a change request. Setups and unsent drafts are kept per run.
- **Archive finished work.** **History** offers **Archive older than 7 days** for the run you are in. Tasks move to `relevo-workflow/archive/<month>.jsonl` with their events, and their evidence leaves the disk. A task an open run still needs stays. The queue holds 200 tasks and says so when it is full.
- **Usage in the status bar.** Each account shows the window closest to its limit, with when it resets. A long window is labelled by its length, so Codex's reads "30d".
- **Lighter while idle.** Slow checks no longer hold other tasks. The Inbox and the run window read a small revision file and only reload when it changes; the Inbox used to parse the whole state and redraw every 5 seconds.

## 0.6.3 · 2026-11-05

- **The Inbox leads with what waits on you.** Sections now run: waiting on you, In Desktop, landing, review requests, your PRs, uncommitted work. Review requests come before your PRs, since a teammate is blocked on them. Agent time folds to "▸ Agent time today · 5h 20m" with **Week** on the line, and merged worktrees to "▸ N merged worktrees" with **Remove N** on the line. A merged worktree with uncommitted files stays in sight, and so does the one a merge alert brings you to. Folds you open stay open after a reload.
- **The summary matches the list.** The reviews and your PRs tiles count only the last 45 days, like their sections; older PRs still fold under "▸ N older than 45 days".
- **The side panel stays as you left it.** Herdr's tabs remembered the side panel per space, so going to an agent in another space opened or closed the Inbox. The layout now uses **relevo-tabs**, Herdr's tabs without that memory. Copy `mods/relevo-tabs` and the layout when you update.
- **PR sessions you can tell apart.** A session opened from a PR card gets a space named after it, like "app #108 · resolve conflicts". **resolve conflicts** now watches the PR's checks after pushing and fixes what the merge broke until they pass.
- **A lighter Relevo.** Fewer processes per scan, fewer redraws across mods, the Tokens scan writes only when something changed, and the Files panel stops polling a folder it already watches.
- **The hook runs in bash.** `relevo-labels.sh` uses `jq` (in macOS 15 and later). It takes about a third of the time and a session end only clears labels. If you set up the hook before, run `bash ~/.config/herdr-app/mods/relevo/hooks/relevo-labels.sh --install`.

## 0.6.2 · 2026-11-05

- **A receipt for each turn.** When a Herdr agent or a Claude Desktop session stops working, Relevo adds up what that turn took: new context, output and the subagents it started. A turn over 5M gets an alert saying how much went to subagents, and **Tokens** lists the day's five heaviest turns.
- **Resolve merge conflicts from the card.** A PR with conflicts leads with **resolve conflicts**: a session in a worktree of the PR's branch that merges the base, keeps both sides working, asks you when a conflict needs a decision, runs the checks and pushes without `--force`. A skill under Settings → Merge conflicts takes the built-in prompt's place, and ▾ always offers the full PR fix beside it.
- **Quieter Inbox.** Desktop sessions ready for review fold under "▸ N ready for review"; only the ones asking something stay open. Landed PRs fold under "▸ N landed", in GitHub's merged purple.
- **A PR stays with its agent.** An agent that ended its turn with a monitor still watching CI is still on its PR: the card says "waiting in the background" instead of offering the skill again.
- **Cards follow the agent.** In a form with several questions, the waiting card moves to the next question as the agent does. It says **Answering…** while your answer goes out and **Next question** when the answer brought another.
- **Land when GitHub hasn't settled.** Right after a push GitHub reports the merge state as unknown for a while; with CI green and no conflict, **Land** shows anyway, since it reads the PR again before merging.
- **PRs that load on a slow day.** The PR list asked GitHub for everything at once and could pass its time limit, which showed as "unexpected end of JSON input". Your PRs now come ten at a time, review requests on their own, and a failed query is tried once more.
- **Fixes.** A click on a waiting card can no longer be lost behind a send that never finished. A stuck read of agents or PRs lets the next one run, and a failed one says so in the Inbox. **Mark seen** no longer misses a same-size edit made in the second the index was written.

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
