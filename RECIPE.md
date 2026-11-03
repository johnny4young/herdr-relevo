# Relevo

A Herdr window for someone who runs coding agents on several Claude accounts at once. The left sidebar shows
each account's 5-hour and 7-day quota above the spaces and agents; the tab bar gains an Inbox button with a
count; a right panel holds the Inbox (agents waiting on you, uncommitted agent work, pull requests that need
something, merged worktrees, agent time today), the Files and Changes panels and Issues. From the Inbox you open
a review pane that sends line comments to the agent, launch PR skills with the right account, and hand an agent's
task to another account.

![Relevo](preview.png)

*The preview is a mockup with demo data, drawn to match the layout.*

## What you see

- **Sidebar** (`chrome`, 268px, collapses to a 44px rail): the Herdr brand row (46px); **Accounts** (158px): a
  header `ACCOUNTS` with an `All | Personal | Work` focus picker, then one 30px row per account and Codex: a
  17px rounded chip in the account's colors with its letter, the label (80px), and two meters (5h, 7d) with the
  percentage, a 4px bar (accent under 50%, `ansi3` from 50%, `blocked` from 80%) and a pace tick where the
  window's time is. Below 160px wide it becomes a rail of chips, each with one 3px bar for the fuller window.
  Then space-folders' spaces and the agents list (equal weight), and Herdr's footer (69px).
- **Tab bar** (42px): Herdr's tabs, an **Inbox** button (92px) with a red count badge, the issues button (78px)
  and a panel toggle (44px, `panel.svg`).
- **Right panel** (380px): a panel bar (66px) with the branch chips of the focused checkout and an
  "Open file in …" finder field (`⌘O`), over a stack of Inbox, Files, Changes and Issues.
- **Files**: Herdr's tree with a right-click menu (New file, New folder, Rename, Move to Trash, Reveal in Finder,
  Copy path, Copy relative path). A preview, and a file opened from the finder, show **Edit**; editing adds a
  7px unsaved dot and **Save** (`⌘S`), and a change on disk shows a bar with **Reload** and **Keep mine**.
- **Inbox**: a rounded (10px) list with a 36px header `Inbox · PRs <age>` and ↻. Groups, each under a 10.5px
  dim header with its count:
  - `WAITING ON YOU`: a card per blocked agent, red border, with the question it asks (read from its screen) and
    its choices as a list: number, a ☑/☐ box in a multiple choice, label and dim description; the agent's cursor
    row is tinted. Below: **Submit** when the form has one, **Reply** when it asks in words, **Agent**. On a
    multi-question form's last step a gray block lists each question with its answer before "Submit answers".
  - `UNCOMMITTED WORK`: a card per resting agent whose checkout has changes: files, `+adds −dels`, buttons
    **Review**, **View diff**, **Files**, **Agent** and **✓** (addressed); addressed ones fold under "▸ N addressed",
    each with **Undo**.
  - `YOUR PRS` and `REVIEW REQUESTS`: cards (9px radius) with a dot, `repo #n · title`, an unresolved-threads
    badge (speech bubble + count, `ansi3`), a CI badge (✓ `ansi2`, ✕ `ansi1`, spinning ring `ansi3` while
    running), the age, why it is here ("CI failing", "changes requested", "review from …"), a split skill button
    (`skill` + account chip | ▾), **Review** on your own PRs, **Open PR** and **✓** (addressed). PRs older than 45
    days fold under "▸ N older than 45 days"; addressed ones under "▸ N addressed", each with **Undo**.
  - `AGENT TIME TODAY` with a **Week** button: one row per ticket (or repo) with today's time.
  - `MERGED WORKTREES`: one 30px row per worktree whose branch merged: repo, branch, age, **Open**/**Go**,
    **Remove**. "▸ N worktrees without a space" folds the rest.
- **Review pane** (opened beside the terminal): header `Review · <folder>` (or `<repo> #n · against <base>` for a
  PR), the changed files (max 150px) with comment counts, a bar with the open file and **Comment on file**, the
  diff with old/new line numbers, green and red rows, and a footer "N comments for <agent>" with **Clear** and
  **Send to agent**.
- **Settings dialog** (800×700, the gear beside ACCOUNTS): accounts (chip preview, label, letter, launcher, Claude
  dir, colors), Codex's launcher, contexts (label, account, orgs), fallback order, repos root and skills; Save.
- **Week dialog** (720×460): `Agent time · week of <date>` with ‹ › and **Copy**, a table of tickets × Mon–Sun
  plus total, today's column in the accent color.
- **Handoff popup** (300px): "Continue <tab> with…" and every other account, Codex included, with its quota. A full
  account can't be picked.

## How it behaves

- **Agent status**: blocked agents become `WAITING ON YOU` cards; a working agent's checkout is left alone until
  it rests; done and idle agents with changes show under `UNCOMMITTED WORK`. A card's age is how long that status
  has lasted, kept in `localStorage` across reloads.
- **Accounts**: a click on a row starts that account's launcher in the focused folder. Hovering a meter shows when
  the window resets. Every 30 s it rereads the statusline snapshots; every 5 min it asks the usage endpoints. Each window shows the newest source that still has it. A statusline should write its snapshot only when the values change, so its date means something.
  At 80% and again at 100% a quota plays `sounds/quota.mp3` and posts a toast; at 100% the toast hands off that
  account's focused, waiting or working agent.
- **Focus picker**: `All`, or one context: the Inbox shows only that context's repos, its space folder unfolds and
  the other's folds, and alerts from the other context are muted. `⌥⌘F` cycles it.
- **Inbox scans**: an in-memory check every 1.5 s of agents, their turns and spaces; a change rescans local work or
  worktrees. So does a shell command ending in a repo, and a change to the git state of a repo with a resting agent
  (`watchFolder` on its git folder, 2 s after the last write; new objects and locks don't count). Reads use
  `--no-optional-locks` with `core.fsmonitor` and `diff.autoRefreshIndex` off, so they can't wake the watch.
  Fallbacks: local work 60 s and worktrees 10 min while the window is active, PRs 3 min. GitHub's merged-PR lists
  are cached 15 min per repo;
  ↻ skips the cache. The Inbox redraws only when a card changes.
- **PR skills**: the left part runs the skill (`/review`, `/fix-ci`, `/address-comments` by default) in a new tab
  in the repo's space with the repo's account, or the next account in `FALLBACK` when it is at 100%. The card then
  follows that agent ("reviewing…", **Agent**). ▾ opens a 320px menu: one chip per account (Codex included), the
  recommended skill and up to two other configured skills you have run, most used first ("used N×", counted from
  each account's `history.jsonl`), and **New session in a worktree of <branch>**: `git worktree add --detach` under
  `~/.herdr/worktrees/<repo>/<branch>` plus `gh pr checkout`, or the branch's existing checkout, then a space with the
  chosen account's agent and a prompt naming only the repo, number and URL (the title and branch are the author's
  text, so the agent reads them with `gh pr view`), told to wait for instructions. A fork's PR gets a local branch
  `pr-<n>`, never a checkout matched by its branch name. Someone else's fork doesn't get a session: an agent there
  could run its code, and no launch flag makes that safe, so the row is disabled.
- **Review on a PR**: uses the PR's checkout when it has one (uncommitted changes included); otherwise fetches
  `+refs/pull/<n>/head:refs/relevo/pr/<n>` and reviews that exact head, with no branch made or moved.
- **Addressed**: ✓ stores the moment in `~/.local/state/relevo/addressed.json`; the card stays out of its group and
  the count until the PR's `updatedAt` is later (a comment, review or push). On an uncommitted-work card ✓ sets the
  terminal label `relevo.addressed=<ms>:<turn>` with `hc label`; the card returns when the agent works, waits or
  starts a later turn. A label takes about 0.65 s to show, so the Inbox keeps the pending value until then.
- **Answering from the Inbox**: before any key, it reads the screen again and compares the dialog with the card as
  drawn: from the dialog's top edge, a whole solid line at the margin (the whole screen without one; a command's lines
  are indented and `╌` fences a diff), to its last choice, plus each choice's label and whether it has Submit. The
  cursor, boxes and a preview beside the choices don't count. If they differ it sends nothing, toasts "The question
  changed" and redraws the card. Reply on a card without choices only checks that no menu, whole or unparsed, has
  appeared, since the paste's Enter would pick an option. A failed or blank read of the screen sends nothing. Measured on Claude Code's menus: a single choice moves the agent's cursor
  with ↑/↓ and presses Enter; a multiple choice toggles a box with its number and **Submit** moves to Submit and presses
  Enter; the free-text choice takes the Reply field's words as a paste (in a multiple choice the cursor goes there
  by arrows and the box is checked again after the paste's Enter). The card rereads the screen after every key.
- **PR alerts**: every PR scan compares your open PRs with the last one and posts a toast when CI fails or passes,
  new review threads appear, or a PR is approved or gets changes requested (a sound on the bad ones).
- **Review pane**: a click on a line opens a comment field, a shift-click extends it to a range, **Comment on file**
  comments on the whole file (Enter saves, Esc cancels); comments survive refreshes
  (every 10 s while you are not typing), closing the pane and restarting Herdr. **Send to agent** pastes the
  numbered comments into the agent's terminal with `hc send`. **Clear** asks once more. Review on the same
  checkout twice focuses the open pane. **Review** on a PR diffs from the merge base with its base branch: the
  checkout's working tree, or the branch itself when it isn't checked out (fetched when not local); with no agent on
  the PR, **Send** starts one in its repo with the repo's account.
- **Settings**: Save validates (required fields, unique keys, the default context claims no orgs, known accounts in
  contexts and fallback) and writes `config.js` atomically; Herdr reloads the mod.
- **Worktrees**: **Remove** turns into a red **Confirm** ("closes its space" when it has one); confirming closes the
  space, runs `git worktree remove` (never forced) and `git branch -d`, shows a spinning "Removing…" and folds
  the row away.
- **Inbox count**: local cards plus fresh, unseen PRs. It pulses while it is higher than when you last opened
  the Inbox.
- **Keyboard**: `⌥⌘3` shows the Inbox and gives it the keyboard (accent border); ↑/↓ select cards and rows,
  Enter runs the main action (go to the agent, review, run the PR's skill or go to its agent, open the
  worktree), Esc returns to the previous pane. `⌘J` jumps to the next agent waiting on you and says how many are
  left. `⌘]`/`⌘[` walk the agents in the Agents list's order. `⌥⌘1–4` show Files, Changes, Inbox, Issues; `⌥⌘B`
  the panel; `⌥⌘D` review; `⌥⌘A` handoff;
  `⌥⌘G` the branch's PR; `⌥⌘R` respond to it; `⌥⌘W`/`⌥⇧⌘W` new or open worktree; `⌥⌘P/O/X` start an account.
  Keys live in the `layout:relevo` section of `keys.json`, and tooltips show them from there.
- **Handoff**: opened by `⌥⌘A`, the agent's account chip, **Continue with…** on a waiting card, or the alert at 95%. A
  working agent gets the stop key first, and nothing starts unless it stopped, so only one edits the tree and the next
  gets its last turn; a resting or waiting agent gets none. Between two Claude accounts, when the agent's `agent.transcript` label names its session file, it
  copies that file into the next account's `projects/` folder and opens a tab with `--resume <id> --fork-session`:
  the same conversation, told to check `git status` first. Otherwise (Codex on either side, or no label) it writes a
  note with the agent's last 160 screen lines, `git status` and the last 5 commits, and the new tab reads it (the
  screen is marked as a record, not instructions). Once the new agent is listed, a toast offers to close the old one,
  which happens only if it's resting, the new one is still there and no helpers run.
- **Ledger**: every 3 s working agents open a stretch and stopped ones close it into
  `~/.local/state/relevo/ledger.jsonl` (`{start, end, jira, repo, branch, account}`). Parallel agents on one ticket
  count once; a stretch across midnight splits.

## Built from

- **Layout** `layouts/relevo.json`, with `layouts/relevo.svg` as the picture Settings shows: `root` row → `sidebar` column (`brand` workspace-chrome, `accounts`
  relevo `{role: "accounts"}`, `sidebar-lists` column with `spaces` space-folders and `agents` relevo-agents,
  `sidebar-footer` workspace-chrome `{footer: true}`) and `work` column (`tab-bar` row with `tabs`,
  `inbox-button` relevo, `issues-button` issues `{button: true}`, `panel-toggle` relevo; `work-body` row with
  `main` and `panel` column: `panel-bar` relevo and `panel-body` stack of `inbox` relevo, `files` relevo-files, `changes`,
  `issues`; `status` workspace-status).
- **mods/relevo**: one View that picks a part by `props().role`: `accounts`, `inbox`, `inbox-button`,
  `panel-toggle`, `panel-bar`, `account-menu`, `find-file`, `handoff`, `review-diff`, `ledger-week`.
  `config.js` holds accounts, contexts, fallback, `REPOS_ROOT` and skills; `lib/` holds pure helpers with
  `node --test` coverage. Only the accounts copy reads `nextCommand()`, so each `relevo.<command>` runs once.
- **hooks/relevo-labels.py** (in mods/relevo): the optional Claude hook behind the `agent.*` labels, reading the
  account from `config.js`. `--check`, `--install` and `--uninstall` change only the `hooks` key of each account's
  settings, with a backup; `HOOK.md` is the runbook for an agent.
- **mods/relevo-agents**: Herdr's agents list with account and ticket chips (from the `agent.account` and
  `agent.jira` labels and the shared `relevo.setup`) and a background marker from `agent.bg` (`⧗2` in `working`
  color, the full "2 shells" in its tooltip).
- **mods/relevo-files**: Herdr's files tree with a right-click menu (`role: "menu"`), a name dialog for New file,
  New folder and Rename (`role: "name"`) and a file pane (`role: "view"`, opened by the finder). Previews and
  the file pane edit through `editor.js`: `writeTextFile` with the text that was read as `expected`, so a file
  changed on disk is never overwritten silently; files of 1 MiB or more, binaries and truncated previews stay
  read-only. Trash is `/usr/bin/trash`; the tree follows renames and new files through shared
  `relevo-files.event`.
- **Community mods**: space-folders (jankeesvw, tested at `cb83ff4`) and issues (jankeesvw).
- **herdr**: `agents`, `panes`, `spaces`, `terminals`, `focused`, `layout`, `shared`/`setShared`, `exec`, `run`,
  `notify`, `openOverlay`, `playSound`, `readTextFile`, `writeTextFile`, `watchFolder`, `nextCommand`, `window`; commands `tab.new`, `space.new`,
  `space.close`, `pane.split`, `pane.focus`, `agent.focus`, `layout.select`, `layout.show`, `layout.toggle`.
- **Programs**: `/usr/bin/trash`, `open -R`, `mv -n`, `mkdir`, `find`, `git`, `gh` (GraphQL for PRs, `pr list --state merged`, `pr view`), `hc read`/`hc send`/`hc label`, `security`
  (Keychain), the account launchers.

## Watch out

- `setShared` redraws every copy of every mod; write only when the value changes, and never from a loop.
- Focus can't move during render: request it from render, move it in `cx.timer.after(30, …)`.
- Handlers inside `list()` item renderers throw; use the list's `on_item_click`.
- `herdr-app check` renders once and runs no handlers; a broken name inside a click handler passes it. Lint for
  undefined names.
- Herdr can't delete a shared key, only set it to null; don't use shared state for debugging.
- The diff starts at the first `@@`; the file headers before it are not rows.
- space-folders' file format is not a contract; Relevo writes `~/.config/herdr-space-folders.json` as of
  `cb83ff4`. Without space-folders the folders don't appear and the rest works.
- Quotas need Claude Code's Keychain item per config dir (`Claude Code-credentials-<sha256(dir)[0:8]>`); an
  expired token is skipped, never refreshed.
- Plain containers can't be scrolled from code and virtual lists forbid handlers in rows, so while the keyboard
  moves down the Inbox hides what is above the selection (keeping one) and shows "↑ N above · Esc".
- Claude Code's menus differ by variant: a number answers a plain single choice, only moves the cursor in one with
  previews, and only toggles a box in a multiple choice. Arrows and Enter work in every single choice.
- `hc keys` rejects non-ASCII keys and drops the whole call; send words as a paste (`hc send`), never key by key.
- Every save reloads the mod and leaves some memory in Herdr's JS engine; after many reloads it reports "out of
  memory". Restart Herdr after a long editing session.
- `/fix-ci` and `/address-comments` are not built into Claude Code; provide them or change `SKILLS`.

## Done when

- The sidebar shows one row per account in `config.js` and Codex, with meters filled within 5 minutes.
- `herdr-app check mods/relevo` passes for every role (set the default role in a scratch copy).
- An agent that stops with changes shows under `UNCOMMITTED WORK` within 2 s; **Review** opens the pane, a
  comment and **Send to agent** reach the agent's terminal, and Review again focuses the same pane.
- A PR with failing CI shows "CI failing", ✕ and a solid `fix-ci` button; ▾ lists every account.
- A merged worktree's **Remove** → **Confirm** removes it with the spinner and the row folds away.
- **Week** opens the table and **Copy** pastes as a table.
- `⌥⌘3`, ↓, Enter on a waiting agent focuses that agent; Esc returns to the terminal.
- ✓ on an uncommitted-work card folds it under "▸ 1 addressed"; a new turn of its agent brings it back.
- A commit in a repo with a resting agent updates its card in about 2 s.
- `node --test 'test/*.test.mjs'` passes in `mods/relevo`.
