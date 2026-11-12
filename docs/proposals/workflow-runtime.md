# How runs work

Open **Runs** in the panel, then open a run to see its window. **Reviews** keeps the original PR, CI, review, account and worktree controls. A run is stored as a goal record; older records open without migration. A task in a run has an expected outcome, a checkout, an implementer and an independent reviewer. An idle terminal is never taken as proof that its task succeeded.

The run window opens on work that needs you. The result shows the agent's summary, the recorded checks and the independent review. Read the changes and evidence as needed, then choose **Accept**, **Request changes** or **Later**. Sessions, messages and skills are under **Tools**. Reading a report does not require opening the agent's session.

Accepting saves the decision and opens the next pending result. When nothing is waiting, the queue says what is still running, paused or finished. Accepted tasks stay in **History**. Before you accept, the window says whether a follow-up task will continue. Tasks that were already started and not paused continue through the coordinator; acceptance can restart a coordinator whose process was lost. It does not start tasks that were only planned, and it does not override a stop. The run's own criteria and any GitHub approval stay separate from accepting a task.

**Request changes** opens a draft before anything is sent. If the round limit is used up, **Prepare follow-up** prefills a separate task for you to review and start; the existing result stays pending. A decision note can be discarded without sending, and drafts are kept per task.

A blocked task leads with the latest review findings. **Retry** and **Resume** appear only when the recorded budget and attempt state allow them, and the coordinator checks the live checkout again. An attempt whose delivery is uncertain must be inspected and reconciled first.

## Execution and decisions

Creating a task records it as planned. **Start** enables a local coordinator process, run through `hc`. The coordinator sends the implementer a bounded assignment, runs the configured checks, sends the same revision to the reviewer, and returns the result for your decision. Reviewer findings can trigger another implementation attempt within the round limit. Dependent tasks wait for your acceptance. One active attempt owns a checkout at a time, and at most two tasks run at once.

Activity records assignment, delivery, report and decision separately. A delivery acknowledgement is not completion. Each agent writes a JSON report for its attempt; the coordinator checks the report's attempt id and token (only the token's hash is stored) and waits for the agent to stop working.

- **Accept** records acceptance of the current checkout fingerprint and lets dependent work continue. It does not approve or merge a GitHub PR or mark the run's manual steps as validated.
- **Request changes** sends your correction to the implementer on the next attempt, then requires an independent review again.
- **Later** leaves the decision pending and pauses new work.
- **Pause** stops new assignments; an agent already working can finish.
- **Pause automation** stops new dispatches and aborts checks in progress without counting that as a failed check. Resuming validates the same saved report without another implementation round.
- **Cancel** cancels the task and asks the agent to stop only when the assigned turn can still be identified. Inspect the session if the stop was not confirmed.

A queued follow-up waits for the agent to be idle; **Send now** targets the implementer through `hc`. During an independent review it stays queued so the checkout does not change. No send bypasses a permission prompt. A follow-up invalidates a pending review. An uncertain delivery is never sent again: wait for the report, or inspect the session and reconcile the attempt.

### Checks

Checks are **No automated checks**, **npm test** or **Custom** (JSON argument lists). No command is inferred from the repository, and choosing a preset does not run it. Each check runs in its own process group, keeps the end of its output, and has its own time budget of up to 10 minutes. Checks that take longer than half a second finish in the background and wake the coordinator, so one slow suite does not hold other tasks. Pausing automation, cancelling the task, stopping the coordinator or starting a newer attempt aborts them.

## Worktree runs

By default a run gets its own worktree. **Start** creates the branch `run/<slug>` from HEAD under `~/.herdr/worktrees/<repo>/`, opens the implementer and reviewer accounts you chose in two tabs there, and starts once both exist. **Existing sessions** uses agents already open in the repository instead.

- **`.worktreeinclude`** at the repository root lists ignored files the run needs, in `.gitignore` syntax. They are copied into the worktree; a path is never written outside it through `..` or a symlinked directory.
- **Accepting** commits exactly the tree the reviewer saw to the run branch, without running hooks. The tree is recorded between two fingerprints of the checkout, so it is used only if the checkout did not change while it was read. Anything changed after the review stays uncommitted.
- **Commit accepted changes** appears when an acceptance was saved but its commit did not land, and commits that same accepted revision.
- **Open draft PR** pushes the run branch and runs `gh pr create --draft` against the branch the run started from.
- **Remove worktree** closes the run's tabs and removes the worktree. It refuses while there are uncommitted changes and keeps a branch that has commits.
- **Discard worktree** is offered on a cancelled run and deletes its worktree with whatever it left uncommitted.
- **Review a batch** accepts several results at once. Runs from the same repository can go in one batch; each run is committed to its own branch and each commit is recorded as it lands.

### What a run agent can touch

A run agent can write its worktree and its own report, and nothing else in the app.

- **Codex** starts with `--sandbox workspace-write` and the reports folder as an extra writable directory. `RUN_CODEX_MODEL` in `config.js` sets its model.
- **Claude** starts with Bash in the operating system's sandbox and no way to run a command outside it. Edit deny rules keep its file tools off Relevo's state, locks, mods and settings. A Claude reviewer gets only Read, Write, Grep and Glob.

These limits apply to agents Relevo starts for a worktree run. An existing session keeps whatever permissions it already has.

## Local state and evidence

State lives under the app home in `relevo-workflow/`, separate from the repository. Writes are locked and atomic; the coordinator and the writers share one lock implementation. The coordinator keeps running when the run window closes. Terminal events and report files drive progress; a timer only checks deadlines. A restart reconciles unfinished deliveries without sending anything twice.

Each write also updates `state.rev`, a few bytes holding the state's revision. The run window and the Inbox poll that file and read the full state only when it changes.

The fingerprint covers HEAD, tracked changes and untracked files that are not ignored. Review and decisions fail closed if it changes. Screenshots, videos and reports you attach are copied into private storage, hashed and bound to the reviewed fingerprint. The limits are 20 MiB per file and 100 MiB in total. Nothing here publishes evidence or session results.

Round, concurrency and per-attempt time limits bound the work. Remote checkouts, automatic account or model selection and provider spending limits are not implemented.

### Archive

The queue holds up to 200 tasks. **Archive older than 7 days**, in a run's **History**, moves that run's finished tasks that have been idle for a week to `relevo-workflow/archive/<month>.jsonl`, with their events, and removes their evidence and reports from disk. A task stays in the queue while:

- its run is open and still reads it: an accepted task linked to a plan step, or the task a decision is linked to;
- another task that is not being archived depends on it, or its plan has unfinished tasks;
- its worktree still exists.

Records are written to a pending file first and join the monthly file only after the state is saved. A reported attempt keeps the first 2,000 characters of its prompt.

## Preferences, skills and input

Configured skills are explicit actions. A skill message carries the selected task's context and accepted preferences; sending a skill is not proof that it completed. The PR skill and account controls in Reviews are unchanged.

A preference has a run or project scope and stays pending until you accept it. Repeated matching corrections can suggest one; a one-off note is not learned. Accepted guidance appears in later task prompts and never grants permissions.

Native text fields accept system dictation as editable text. Nothing is sent until you send it.

## Installation and rollback

`scripts/live-relevo.mjs` installs the mod with a backup path. It preserves `config.js`, accounts, layouts, keys, run records and sessions. Its rollback launcher stops the coordinator before restoring code. Running agent sessions are not killed, and private state and evidence stay on disk. See [installation and rollback](decision-inbox.md).

This is a bounded coordinator for one task at a time per checkout. Breaking a goal into tasks and choosing agents stay with you, and accepting a result is always your action.

For the product goal, the research behind it and the engineering handoff, see the [continuation guide](workflow-continuation.md).

## Everyday use

Open a run to see **Needs you** first. Read the result and the evidence, then **Accept** or **Request changes**. Accepting advances the queue; dependent tasks continue only when their prerequisites are accepted and automation is on.

**Tools** (**T** in the run window) searches task actions, configured skills and agent sessions. Choosing a skill previews its command and recipient; **Queue skill** sends it. Queued work can change a pending result, so look at new changes before accepting. **Activity** shows who received each assignment and what they reported.

**New task** starts from the outcome you want. A run with no outcomes offers **Create first task** with its prompt filled in. **Start** creates and starts the task in one step; **Save for later** keeps it planned. Drafts survive switching sections and validation errors. Escape leaves a text field first, then returns to the queue, then closes the window.
