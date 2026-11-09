# Local goal workflows

Open **Workflow** from an existing goal in Inbox. Goals still group the original PR, CI, review, account and worktree controls. A workflow task adds an explicit expected outcome, local checkout, executor and independent reviewer. It links existing agent sessions; it does not create accounts or infer that a terminal's idle state means its task succeeded.

The queue opens on work needing attention. **Review** summarizes the result, recorded checks and independent review. Review changes and evidence as needed, then choose **Accept result**, **Request changes** or **Decide later**. Sessions, messages, skills and limits live under **Task details & controls**. Reading reports does not require opening an agent session. Decision controls also appear after the detailed reports so you can act where you finish reviewing.

Acceptance saves the decision and automatically opens the next pending item. When no decision remains, the queue shows a confirmation describing ongoing, paused or completed work. Accepted tasks remain available in **History**. There is no manual Next step action. Before accepting, the UI explains whether a follow-up is defined and eligible to continue. Already-started, unpaused dependencies continue through an enabled coordinator; acceptance can recover that coordinator if its process was lost. It does not start merely planned tasks or override an explicit stop. Goal-level criteria and GitHub approval remain separate from individual task acceptance.

Request changes opens a feedback draft before anything is sent. If the round limit is exhausted, **Prepare follow-up** prefills a separate task for you to review, create and start explicitly; the existing result remains pending. Optional decision notes can be discarded without sending, and drafts stay separate between tasks.

## Execution and decisions

Create records a planned task. Start enables a local coordinator process under `hc`. The coordinator sends the executor a bounded assignment, observes the configured checks, sends the matching revision to the reviewer, and returns the result for human review. Reviewer findings can trigger another implementation attempt within the configured round limit. Dependent tasks wait for explicit acceptance. One active attempt owns a checkout at a time; at most two tasks run concurrently.

Activity records assignment, delivery acknowledgement, attempt report and human decision separately. A transport acknowledgement is not completion. Each agent writes an attempt-specific local JSON report; the coordinator validates its identity and waits for the reporting session to stop working. Checks are separately observed command results. The UI can open the existing diff reviewer and agent session.

- **Accept result** records acceptance of the current checkout fingerprint and permits dependent work. It does not approve or merge a GitHub PR or validate the goal's manual steps.
- **Request changes** sends the recorded correction to the assigned executor on the next available attempt, then requires independent review again.
- **Defer** leaves the decision pending and pauses new work.
- **Pause** stops new assignments; an already running agent can finish.
- **Cancel** cancels the workflow and requests an interrupt only when the assigned turn can still be identified. Inspect the session if stopping was not confirmed.

Queue a follow-up to wait for a safe idle point; **Send now** targets the current executor through `hc`. During an active independent review it stays queued to preserve the checkout. Exact status guards are used for idle/working sessions; `hc` has no exact done guard, so a freshly observed done session uses normal delivery. No send bypasses a permission prompt. A follow-up invalidates a pending review. Uncertain deliveries are never resent automatically: wait for the correlated report, or inspect the session and explicitly reconcile the stopped attempt before starting another.

## Local state and evidence

State is stored under the app home in `relevo-workflow/`, separate from the repository. Writes are locked and atomic. The coordinator survives closing the workflow dialog. Terminal events and local report events drive progress; a lightweight timer checks deadlines. A restart reconciles unfinished deliveries without repeating effects.

The fingerprint includes HEAD, tracked changes and nonignored untracked bytes. Review and decisions fail closed if that fingerprint changes. Local screenshots, videos and reports are copied into private artifact storage, hashed and bound to the reviewed fingerprint. Attachment limits are 20 MiB per file and 100 MiB total; remove an artifact from Evidence to reclaim its copy. Original files are retained. Nothing in the workflow publishes evidence or session results.

Only explicitly configured command argument arrays run as checks; no test command is guessed. Local repositories and local agent addresses are supported. Remote checkouts, automatic account/model selection and provider-enforced monetary limits are not implemented. Round, concurrency and per-attempt time limits bound work; provider spend remains unknown where no verified usage is available.

## Preferences, skills and input

Configured skills remain explicit actions. A workflow skill message includes the selected task context and accepted preferences; invoking a skill is not proof that it completed successfully. Existing PR skill/account controls remain available.

Preferences have a goal or project scope and remain pending until accepted. Recurring matching corrections can suggest a preference; one-off notes are not silently learned. Accepted guidance appears in subsequent task prompts and never grants permissions. Preferences can be edited, rejected or removed.

Native text fields accept system dictation as editable text. The user reviews the text and invokes Send; there is no automatic voice-command execution or built-in speech service.

## Installation and rollback

Use `scripts/live-relevo.mjs` to install the mod with a fresh backup path. It preserves `config.js`, accounts, layouts, keys, goals and sessions. Its standalone rollback launcher stops the local coordinator before restoring code. Running agent sessions are not killed, and private state/evidence stay on disk for inspection. An edit made after installation blocks rollback before code is overwritten.

This is a bounded task coordinator, not an autonomous chief of staff. Goal decomposition and role selection remain explicit. Human goal acceptance stays separate from test execution and workflow completion.
