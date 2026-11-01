# Relevo

A Herdr layout for running coding agents across several Claude accounts: quotas per account, an Inbox where
you answer agents waiting on you and triage pull requests, uncommitted work and merged worktrees, a review pane
for local changes or whole PRs that sends line, range and file comments to the agent, handoffs between accounts,
alerts when a PR's CI or reviews change, and a ledger of agent time per ticket.

![Relevo](preview.png)

*The preview and screenshots are mockups with demo data, drawn to match the layout.*

## What it does

### Answer agents without leaving your work

A waiting agent's question shows in the Inbox with its choices, its preview and a note field. Click a choice and
the agent continues; multiple choice gets a Submit.

![An agent's question answered from the Inbox](screenshots/answer.png)

### Review a whole PR, then hand the comments to its agent

Click a line or shift-click a range, comment, and **Send to agent**. Your PR cards open the PR against its base even
when the branch isn't checked out.

![The review pane with range and line comments](screenshots/review.png)

### Never stop at 100%

Each quota bar says when it runs out at the current pace. At 95%, an alert offers to continue the agent with another
account; it writes the handoff note for you.

![A quota at 95% and the handoff to another account](screenshots/handoff.png)

### Edit files in the panel

Right-click in Files to create, rename, trash, reveal or copy a path. Edit a preview and save with ⌘S; a change on
disk while you edit asks **Reload** or **Keep mine**, so nothing is overwritten silently.

![The Files panel's menu and a file being edited](screenshots/files.png)

### Every checkout, one click away

The panel bar's selector lists every checkout of the repo with uncommitted files, ahead/behind and last use. Merged
worktrees that are safe to remove go in one Confirm.

![The checkout selector and merged worktrees](screenshots/worktrees.png)

## Install

1. Install the two community mods it uses: [space-folders](https://github.com/jankeesvw/herdr-space-folders)
   and [issues](https://github.com/jankeesvw/herdr-issues) (from herdr.dev, or copy their folders into
   `~/.config/herdr-app/mods/`).
2. Copy `layouts/relevo.json` to `~/.config/herdr-app/layouts/` and `mods/relevo`, `mods/relevo-agents` and
   `mods/relevo-files` to `~/.config/herdr-app/mods/`. Merge `keys.json` into yours.
3. Switch to the layout (`ctrl-shift-l`) and open Settings (the gear beside ACCOUNTS): your accounts, the GitHub
   orgs that use each one, and where your clones live. It writes `mods/relevo/config.js`, which you can also edit.

It needs `git` and the GitHub CLI (`gh auth login`) on your PATH, and `claude` and optionally `codex`.

Waiting agents' questions are answered from the Inbox for Claude Code and Codex. Codex only asks them in Plan mode;
outside it, it decides on its own.

## What it reads and runs

- Runs `git`, `gh`, `hc` and the launchers in `config.js`; Files runs `/usr/bin/trash`, `open -R`, `mv -n` and `mkdir`.
- Reaches the network for quotas: each Claude account's login from the macOS Keychain goes to Anthropic's usage
  endpoint, and Codex's `~/.codex/auth.json` to ChatGPT's. It never refreshes or writes a token.
- Writes `~/.local/state/relevo/ledger.jsonl` (agent time) and `~/.local/state/relevo/handoff/` (handoff notes),
  the folders it adds to space-folders' file, and files you create, rename or save in Files.
- Optional: sounds at `~/.config/herdr-app/sounds/{quota,review,bg-done}.mp3`; quota snapshots a Claude
  statusline writes to `~/.cache/herdr-relevo/quota-<account>.json`; `agent.account` and `agent.jira`
  terminal labels from a Claude hook, for account chips and per-ticket time.

## Tests

`node --test 'test/*.test.mjs'` from `mods/relevo` and `mods/relevo-files`, and `npx eslint@10.13.0 mods` from the root for undefined names (Node from `.nvmrc`). CI runs both on every push.

## License

Apache 2.0. See NOTICE for the parts derived from Herdr.
