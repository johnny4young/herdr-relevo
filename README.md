# Relevo

A Herdr layout for running coding agents across several Claude accounts: quotas per account, an Inbox where
you answer agents waiting on you and triage pull requests, uncommitted work and merged worktrees, a review pane
for local changes or whole PRs that sends line, range and file comments to the agent, handoffs between accounts,
alerts when a PR's CI or reviews change, and a ledger of agent time per ticket.

![Relevo](preview.png)

*The preview and screenshots are mockups with demo data, drawn to match the layout.*

## Runs: hand a task to two agents

The panel has two views. **Reviews** is the Inbox described below. **Runs** is for work you hand off: one agent implements, your checks run, a second agent reviews, and the result waits for your decision.

1. **+ Run** takes a prompt. Its first line names the run.
2. Pick the repository, the checks (none, `npm test` or your own commands) and who implements and who reviews. Accounts at 100% are skipped.
3. **Start**. By default the run gets its own worktree, `run/<slug>` under `~/.herdr/worktrees/<repo>/`, and both agents open there in two tabs. **Existing sessions** uses agents you already have open in the repository instead.
4. The result appears under **Ready for you** with its agents, round, checks, verdict and age. Open it to read the summary, the diff and the evidence, then accept (**A**, then Enter), request changes (**R**) or defer.

**What accepting does.** In a worktree run, acceptance commits exactly the tree the reviewer saw to the run branch, without running hooks. Anything changed after the review stays uncommitted. From there the run offers **Open draft PR** (pushes the branch and runs `gh pr create --draft`) and **Remove worktree**, which keeps a branch that has commits. A cancelled run offers **Discard worktree**. Accepting never approves, merges or pushes anything by itself.

**Files a worktree needs.** A new worktree has only tracked files. List the ignored files a run needs, such as `.env`, in a `.worktreeinclude` at the repository root, in `.gitignore` syntax; they are copied into each run's worktree.

**What a run agent can touch.** Its worktree and its own report, nothing else. Codex runs with `workspace-write`; set `RUN_CODEX_MODEL` in `config.js` to choose its model. Claude runs Bash in the system sandbox, and its file tools cannot edit Relevo's state, mods or settings. A Claude reviewer has no shell at all.

**Limits.** Each run has a maximum number of correction rounds and minutes per attempt, and two runs work at a time. A message Relevo cannot confirm was delivered is never sent again: the run waits for you to look at the agent and reconcile it.

**More than one result.** **Review a batch** previews and accepts several results of one repository at once. **History** keeps finished tasks; **Archive older than 7 days** moves the ones the run no longer needs to `relevo-workflow/archive/`.

**Keys.** Click the panel heading to focus the queue: **↑/↓** selects, **G** goes to the next run, **F** shows one run or all, **W** opens the run, **E** opens its details, **R** opens review where there is one, **?** lists every shortcut. In the run: **1–5** switch views, **N** starts a task, **P** opens the plan, and Command-Enter submits the prompt or a change request.

A run can also carry a plan of steps, an owner and a priority, and group the PRs and local changes that belong to it. See [how the coordinator works and its limits](docs/proposals/workflow-runtime.md), the [keyboard guide](docs/proposals/goal-ux.md) and [installation and rollback](docs/proposals/decision-inbox.md).

## Native Decision Inbox preview

Try the goal-aware Inbox inside the real Herdr app, in an isolated local profile with fictional data. See the [native preview instructions](docs/previews/native-decision-inbox.md). It keeps the existing Inbox and does not change your installed configuration or connect to real agents.

To inspect your actual saved workspace/tab metadata without connecting the preview to live agents, use the separate [local metadata snapshot](scripts/SNAPSHOT.md). It keeps real names and relationships, marks missing goals and states as unknown, and does not import accounts or credentials.

## What it does

### Answer agents without leaving your work

A waiting agent's question shows in the Inbox with its choices, its preview and a note field. Click a choice and
the agent continues; multiple choice gets a Submit. Any other time, `⌥⌘S` sends a message or one of your saved
replies, like "commit and push". `⌥⌘E` finds a past session of this repo and resumes it with its account.

![An agent's question answered from the Inbox](screenshots/answer.png)

### See what happened while you were away

Back after ten minutes or more, a card at the top of the Inbox lists which agents finished and what they said last,
which ones wait for you, what changed on your PRs and how much quota and agent time went. Click a row to go there.

![While you were away: finished and waiting agents, PR changes and quota spent](screenshots/away.png)

### Review a whole PR, then hand the comments to its agent

Click a line or shift-click a range, comment, and **Send to agent**. Your PR cards open the PR against its base even
when the branch isn't checked out.

![The review pane with range and line comments](screenshots/review.png)

### Never stop at 100%

Each quota bar says when it runs out at the current pace. Click an agent's account chip, or press `⌥⌘A`, to continue it
with another account; an alert offers the same at 95%. Between Claude accounts the next one resumes the same conversation; to or from Codex it starts from a note
with the last screen and the working tree. `⌥⌘N` starts a new agent on the Claude account with the most room left.

![A quota at 95% and the handoff to another account](screenshots/handoff.png)

### See where your tokens go

`⌥⌘U` opens **Tokens**: output and new context by surface (Claude Desktop, terminal, automatic sessions, Codex),
project, subagent type and day. It reads the transcripts on your Mac and sends nothing anywhere.

![Tokens by surface, project, subagent and day](screenshots/tokens.png)

### Claude Desktop sessions too

Desktop sessions that ask you something or wait for a review show in the Inbox and the Agents list, one click from
Desktop. With Herdr behind another app, alerts reach macOS; with `terminal-notifier`, a click lands on the agent.

### Land a PR, and review only what changed

**Land** merges a ready PR at the commit you saw, follows the workflows the merge starts and removes its worktree
when nothing would be lost. In the review pane, **Since I looked** shows only what the agent changed after your
last look, and **Viewed** marks files until they change.

![A PR landing, one landed, and one ready for its second click](screenshots/land.png)

![Since I looked, with one file marked viewed](screenshots/since.png)

### Resolve conflicts, and see what each turn cost

A PR with merge conflicts offers **resolve conflicts**: an agent in a worktree of its branch that merges the base
and pushes without `--force`, then watches CI until it passes. When an agent's turn ends, a receipt says what it took and how much went to
subagents; a heavy one gets an alert.

### Edit files in the panel

Right-click in Files to create, rename, trash, reveal or copy a path. Edit a preview and save with ⌘S; a change on
disk while you edit asks **Reload** or **Keep mine**, so nothing is overwritten silently.

![The Files panel's menu and a file being edited](screenshots/files.png)

### Every checkout, one click away

The panel bar's selector lists every checkout of the repo with uncommitted files, ahead/behind and last use. Merged
worktrees that are safe to remove go in one Confirm. When your PR merges, the toast takes you to its worktree.

![The checkout selector and merged worktrees](screenshots/worktrees.png)

## Install

1. Install the two community mods it uses: [space-folders](https://github.com/jankeesvw/herdr-space-folders)
   and [issues](https://github.com/jankeesvw/herdr-issues) (from herdr.dev, or copy their folders into
   `~/.config/herdr-app/mods/`).
2. Copy `layouts/relevo.json` and `layouts/relevo.svg` to `~/.config/herdr-app/layouts/` and `mods/relevo`, `mods/relevo-agents`,
   `mods/relevo-files` and `mods/relevo-tabs` to `~/.config/herdr-app/mods/`. Merge `keys.json` into yours.
3. Switch to the layout (`ctrl-shift-l`) and open Settings (the gear beside ACCOUNTS): your accounts, the GitHub
   orgs that use each one, and where your clones live. It writes `mods/relevo/config.js`, which you can also edit.

It needs `git` and the GitHub CLI (`gh auth login`) on your PATH, and `claude` and optionally `codex`.

Waiting agents' questions are answered from the Inbox for Claude Code and Codex. Codex only asks them in Plan mode;
outside it, it decides on its own.

## Update

Herdr doesn't update mods from others, and adding Relevo again installs a renamed second copy, so copy the new files
over the old ones. From a clone of this repo:

```sh
rsync -a --exclude config.js mods/relevo/ ~/.config/herdr-app/mods/relevo/
rsync -a mods/relevo-agents/ ~/.config/herdr-app/mods/relevo-agents/
rsync -a mods/relevo-files/ ~/.config/herdr-app/mods/relevo-files/
rsync -a mods/relevo-tabs/ ~/.config/herdr-app/mods/relevo-tabs/
cp layouts/relevo.json layouts/relevo.svg ~/.config/herdr-app/layouts/
```

Mods reload by themselves. `--exclude config.js` keeps your accounts; copying that file over yours resets them. Don't add `--delete`: it removes your own icons. Compare
`keys.json` with yours and add what's new. Relevo's keys now live in a `layout:relevo` section; if yours are under
`global`, move them so they only act while Relevo shows.

## What it reads and runs

- Runs `git`, `gh`, `hc`, `find` (to look for repos in a worktree's ignored folders) and the launchers in `config.js`; Files runs `/usr/bin/trash`, `open -R`, `mv -n` and `mkdir`.
- Reaches the network for quotas: each Claude account's login from the macOS Keychain goes to Anthropic's usage
  endpoint, and Codex's `~/.codex/auth.json` to ChatGPT's. It never refreshes or writes a token.
- Reads each Claude account's `history.jsonl` to rank the skills a PR's menu offers (counts only), its short
  one-line prompts to suggest quick replies you keep typing, and its sessions for `⌥⌘E`, with the title, branch and
  PR from the end of each session file (in memory, never written anywhere).
- Reads every Claude account's `projects/` transcripts and Codex's `~/.codex/sessions` for token counts (message
  ids, models, token numbers, folders, session titles), and Claude Desktop's session files in
  `~/Library/Application Support/Claude/claude-code-sessions` (title, folder, and whether a session asks or waits for
  a review). Keeps the counts in `~/.local/state/relevo/usage/`.
- Merges, updates and marks PRs ready only when you click (`gh pr merge`, `gh pr update-branch`, `gh pr ready`), and
  re-runs failed jobs with `gh run rerun --failed`. **Save checkpoint** stores a git tree under `refs/relevo/seen/` for **Since I looked**. **Mark file viewed** and **Mark all viewed** track reviewed file contents separately.
- Runs keep their state in `~/.config/herdr-app/relevo-workflow/` (tasks, attempts, agent reports, evidence up to 100 MB, and the archive) and run metadata in `~/.config/herdr-app/relevo-goals.json`. While a run is working, a coordinator (`node`, started with `hc run --bg`) sends each agent its task with `hc send`, runs the checks you configured in the run's checkout, and stops when nothing is left to do. A worktree run adds a worktree under `~/.herdr/worktrees/` and a `run/…` branch; it commits to that branch only when you accept, and pushes it and runs `gh pr create --draft` only when you click **Open draft PR**.
- Shows macOS notifications with `terminal-notifier` when installed, else `osascript`.
- Writes `~/relevo-backups/deletions.log` (each worktree it removes: time, repo, path, branch and commit),
  `~/.local/state/relevo/ledger.jsonl` (agent time), `~/.local/state/relevo/replies.json` (how often you send
  each saved quick reply), `~/.local/state/relevo/addressed.json` (PRs marked
  addressed) and `~/.local/state/relevo/handoff/` (handoff notes); a PR session adds a worktree under
  `~/.herdr/worktrees/`;
  a handoff between Claude accounts copies the session file into the next account's `projects/` folder;
  the folders it adds to space-folders' file, and files you create, rename or save in Files.
- Sets a `relevo.addressed` terminal label on local work you mark addressed, and watches the git folders of repos
  with a resting agent. Its repeated git reads write nothing there.
- Optional: sounds at `~/.config/herdr-app/sounds/{quota,review,bg-done}.mp3`; quota snapshots a Claude
  statusline writes to `~/.cache/herdr-relevo/quota-<account>.json` (only when the values change, or an idle session's
  old values look new); `agent.account`, `agent.jira` and
  `agent.transcript` terminal labels from a Claude hook, for account chips, per-ticket time and resumed handoffs.
- That hook is one optional Claude hook on three events (SessionStart, Stop, SessionEnd), in bash with `jq`, and it only sets terminal
  labels: account, ticket, session file and background tasks. Without it Relevo still runs; you lose account chips,
  resumed handoffs (handoffs use the note) and the background-task marker, while ticket time falls back to the ticket
  in the branch name. To set it up, tell your agent: `Read ~/.config/herdr-app/mods/relevo/hooks/HOOK.md and follow it.`

## Tests

`node --test 'test/*.test.mjs'` from `mods/relevo` and `mods/relevo-files`, and `npx eslint@10.13.0 mods` from the root for undefined names (Node from `.nvmrc`). CI runs both on every push.

## License

Apache 2.0. See NOTICE for the parts derived from Herdr.
