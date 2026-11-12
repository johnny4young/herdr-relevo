# Runs: goal and continuation guide

Read this first when continuing this work, then inspect the actual checkout, current PR head and local runtime state. It started as [PR #40](https://github.com/johnny4young/herdr-relevo/pull/40), which stays open as a reference, and is split into three stacked PRs: [#41](https://github.com/johnny4young/herdr-relevo/pull/41) (account usage in the status bar), [#42](https://github.com/johnny4young/herdr-relevo/pull/42) (the coordinator) and [#43](https://github.com/johnny4young/herdr-relevo/pull/43) (the Runs UI). #43 has the same content as #40. Every code or documentation commit changes the checkout fingerprint; old evidence must not silently become evidence for a new revision.

The current UI is **Reviews + Runs**, with a prompt-first start and compact account usage in the status bar. Read [how runs work](workflow-runtime.md) for current behavior and [Runs UX](runs-ux.md) for the design rationale and follow-up ideas. The UI says run; the research records use Goals or Missions for the same stored goal records.

## Product goal

Make Herdr's existing Inbox the place to direct and review work: understand the outcome, priority, owner, executor, review evidence, decision and what happens next without visiting every agent chat. Reduce corrections and context switching while retaining human judgment and existing security/review checks.

Preserve spaces, terminals, agents, accounts, GitHub, PRs, CI, reviews, Land, drafts, addressed work, handoffs, worktrees and the original review Inbox. Reorganize these capabilities where helpful; do not create a competing Inbox or replace the host shell. Product UI and documentation are English. The OS may provide editable dictation, but this workflow has no dedicated voice surface or mobile workflow.

## Working agreements

- A change goes to the PR that owns its files: `mods/relevo/runtime` and its tests to #42, the UI and documentation to #43, and #40's branch (`feat/review-command-center`) is kept identical to #43. No merge or release is authorized by this handoff.
- Work through implementation, integration, bug fixes and validation continuously. Intermediate milestones are internal checks; present the integrated PR for one complete human review instead of asking the user to approve each iteration.
- Keep public research, design rationale, generic code and regression tests in the PR. Keep local project/session names, captures, reports, workflow state and exercise results outside Git and PR text.
- Inspect existing worktrees and instructions before editing. Do not assume an older preview checkout is authoritative or overwrite unrelated work.
- Preserve the original pre-PR version as a rollback destination, not only the preceding iteration. Never reset accounts, keys, layouts, sessions or goal records to install a mod.
- Prefer Bash for simple automation and JavaScript when Bash is unsuitable. Do not introduce Python or put laboratory tooling into the product.
- Use existing authorized low-cost agents for bounded validation. Check their actual model, availability, working directory and permissions; do not infer them from labels. Coordinate expensive checks with other local laboratories and avoid unnecessary disk copies.
- A stopped coordinator, exhausted budget or uncertain delivery is not permission to silently restart, increase limits, resend or accept. Use the documented explicit recovery/follow-up path within the user's authorization.

## Implemented behavior and remaining work

| Area | Implemented in this branch | Still needs work or explicit acceptance |
| --- | --- | --- |
| One Inbox | Reviews/Runs, focus/All runs, linked PR/local work and existing actions | Keep everyday comprehension and density part of native validation. |
| Goal progress | Owner, priority, optional lead, criteria, manual steps, workflow-derived outcomes | Goal closure remains human; assigning a lead does not create a chief of staff. |
| Coordination | Durable local `hc` executor → checks → independent reviewer → human flow; bounded corrections | Automatic decomposition, global orchestration and remote checkout execution are out of scope. |
| Worktree runs | A worktree and `run/<slug>` branch per run, `.worktreeinclude`, acceptance commits the reviewed tree without hooks, draft PR, remove or discard, batch acceptance | **Open draft PR** has only been exercised on its failure path; try it against a real remote. |
| Containment | Codex with `workspace-write`; Claude with sandboxed Bash and Edit deny rules over the app's files | Existing sessions keep their own permissions. A same-user process outside the sandbox can still edit local state. |
| Housekeeping | Archive per run with staged records, a 200-task queue limit, a revision file for polling, checks off the coordinator tick | Archived tasks cannot be read from the app. |
| Continuation | Acceptance advances the queue and releases already-started eligible dependents | Never start a planned task or override a stop merely because an earlier result was accepted. |
| Controls/recovery | Pause/resume/stop/cancel, attempt correlation, uncertain-send reconciliation, revision checks | Keep pause/stop regression coverage and distinguish independent source review from native end-to-end verification. |
| Review | Existing diff; explicit comment Save/Cancel/Delete; selected/all viewed controls; separate checkpoint | Verify keyboard/focus behavior through the native app, not only render tests. |
| Tools and skills | Searchable Tools and agent pickers, explicit previous-setup reuse, recipient/command preview, explicit Queue skill, task-specific message drafts | No automatic provider switching or model selection. |
| Activity | Actual assignment, delivery and report provenance; expandable prompts/logs | Do not call model routing or external-chat coordination autonomous agent delegation. |
| Evidence | Revision-bound local artifacts with hashes and quota; PR evidence references | Automatic screenshot/video production and richer archival are not implemented. |
| Preferences/input | Pending scoped preference proposals, explicit acceptance, editable system dictation, decision batches | No built-in speech capture; reduced corrections must be measured, not asserted. |
| Accessibility | Native keyboard controls, visible help/tooltips, focus-aware shortcuts; the run opens as a pane beside the work | Full screen-reader acceptance remains open, including native input names and noninteractive content. |
| Rollback | Checksummed installer and standalone rollback launcher | Verify the selected backup really restores the original version and preserve later local edits. |

The [research record](workflow-research.md) explains the source ideas and their limits. Do not treat every proposal there as implemented.

The [Paseo follow-up](paseo-research.md) adds a pinned source comparison and adoption priorities. Check summaries distinguish no checks, unrun checks, partial evidence and explicit failures, including timeouts. Prior results are suppressed while a fresh executor attempt runs or reports that implementation did not complete; cancellation stays incomplete. Searchable shortcut help uses current effective bindings and modifier aliases. Unsent task briefs can be resumed or discarded per run; resume rechecks live agent/root availability and does not dispatch. Saved setups are local and repository-scoped; applying one fills the form for review and never starts work or routes to a model/provider.

## Normal user journey

1. Open Reviews for existing changes, or Runs → + Run to enter a prompt. Choose agents saves the brief and opens setup with the repository's last agents filled in; Start creates and starts the task. Existing runs open their current result or recovery action. Stored records remain compatible.
2. Read Result and inspect changes/Evidence as necessary. Activity answers who assigned what; Tools contains secondary actions and configured skills.
3. Accept, Request changes or Later. Acceptance records the current revision and explains the next effect. It is not GitHub approval, merge, or goal closure.
4. Already-started eligible work proceeds through an enabled coordinator. If work is stopped, blocked, missing evidence or out of budget, explain that state and the specific recovery action.
5. Accepted work stays in History. Close the goal only after its actual outcomes and outstanding decisions have been reviewed by the user.

The guiding UX question is: can the user understand what to do here and what will happen after one action? Do not solve confusion by adding more counters, explanatory paragraphs or duplicate buttons to the main card. Derive status from current records; manually written next-decision/recommendation text can become stale after acceptance and needs attention.

Task setup can explicitly reuse the latest successful setup in the same run while retaining the new title, criteria and dependencies. Unavailable or incompatible sessions are not restored. A narrow run window switches between the task list and the selected work, and batch review selects entries in the existing queue rather than creating a second list. Runs without predefined outcomes show Work from brief and their actual task states instead of a misleading 0/0 counter. Finish run is the sole closure action; accepting a task does not finish the run.

The current usability iteration derives the card's primary action from live tasks, keeps saved prose and outcome progress behind Edit, and offers a bounded follow-up when a settled blocked attempt has exhausted its budget. Run cards show a compact current-action row; Edit retains the full plan and context. File search now exposes its result list and loading/error/empty states. A run creates its worktree when you press Start with **Own worktree** selected; nothing creates one before that. Continue validating these native interactions before broadening the feature set; a render-unit test cannot prove popup sizing or screen-reader exposure.

## Resume engineering work

1. Read repository instructions and the installed Herdr app's `AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`. Read `hc --skill` before orchestrating connected agents. The native mod uses GPUI, not HTML/DOM.
2. Inspect `git status`, branch, head and PR status. Check the local workflow state using the CLI below. Resolve the actual app home and connected sessions locally; no private addresses or laboratory paths are published here.
3. Preserve recorded human decisions and reports. Inspect the latest attempt, review findings, round budget, revision and paused/engine state before doing anything. Do not repeat acceptance of previously accepted work. An exhausted review must remain in history; prepare a scoped follow-up through supported commands/UI instead of rewriting state or raising its budget in place. Read local evidence to determine which validation is still outstanding.
4. Review commit `16bff6e`: pause/stop during asynchronous dispatch preparation now exits without sending or marking Blocked; stopping checks leaves the executor report available for explicit resume rather than recording a false test failure or consuming another implementation round. Regression tests reproduce both paths and verify no duplicate executor send.
5. Validate the current checkout with focused checks, then applicable repository gates. Independent reviewer reports must distinguish code inspection, observed test output and actual native interaction. A passing test suite is not human acceptance.
6. Exercise the corrected path in the current Herdr session with bounded low-cost agents when authorized and available. Return the current reviewed result to Needs you. Keep the goal open until the user accepts the relevant outcome; do not fabricate a clean review or silently discard an earlier finding.
7. Prioritize clear blocked/recovery actions, current next-action text, narrow-panel readability and accessibility before adding further orchestration layers. Capture UI evidence locally and preserve rollback at each deployment.

The PR is the portable product/engineering handoff. Private task state, agent reports, screenshots and backup manifests remain on the originating machine. A session without that machine can continue code and documentation work, but cannot infer live task IDs, acceptance, agent availability or a valid backup from this document.

## Code map

| Concern | Entry points |
| --- | --- |
| Inbox and goal UI | `mods/relevo/main.js`, `goals-editor.js`, `inbox-goals.js`, `goals-store.js`, `lib/decision-inbox.js`, `lib/goals.js` |
| Run window: queue and task form | `mods/relevo/workflow.js`, `workflow-window.js`, `lib/workflow-navigation.js` |
| Run window: launch, accounts and worktree panel | `mods/relevo/workflow-runs.js` |
| Run window: decision, activity, evidence, Tools | `mods/relevo/workflow-detail.js`, `workflow-labels.js`, `lib/agent-markdown.js` |
| Plan and completion projection | `mods/relevo/workflow-plan.js`, `lib/goal-plan.js`, `lib/goal-workflow.js` |
| Coordinator, command boundary, durable state and locks | `mods/relevo/runtime/coordinator.mjs`, `cli.mjs`, `store.mjs` |
| Worktrees and archive | `mods/relevo/runtime/worktree.mjs`, `archive.mjs` |
| Check execution, fingerprint and evidence | `mods/relevo/runtime/evidence.mjs`, `process.mjs` |
| Preferences | `mods/relevo/lib/workflow-preferences.js` |
| Diff/comment interaction | `mods/relevo/review.js` and its tests |
| Reversible deployment | `scripts/live-relevo.mjs`, `scripts/relevo-layout.mjs` and their script tests |
| Status-bar accounts | `mods/relevo/account-status.js`, `lib/account-status.js` |

Paths after the first filename in each row share that row's module directory. Consult [runtime behavior](workflow-runtime.md), [goal interaction](goal-ux.md), [installation](decision-inbox.md) and [preview distinctions](../previews/native-decision-inbox.md).

## Reproducible checks and local inspection

Use the repository's Node version from `.nvmrc`. These commands are instructions, not a record of private run results:

```sh
git status --short
git branch --show-current
git rev-parse HEAD
node --test --test-concurrency=1 mods/relevo/test/workflow-runtime.test.mjs mods/relevo/test/workflow-plan.test.mjs
node --test --test-concurrency=1 mods/relevo/test/*.test.mjs mods/relevo-files/test/*.test.mjs scripts/tests/*.test.mjs
npx --yes eslint@10.13.0 mods scripts
git diff --check
```

The current [CI definition](../../.github/workflows/ci.yml) is authoritative for repository gates. Acquire any host-specific shared QA lane before heavy local checks. Documentation-only edits do not require another full runtime test run.

With `HERDR_APP_HOME` resolved to the actual running instance, read private state without publishing the output:

```sh
node mods/relevo/runtime/cli.mjs --home "$HERDR_APP_HOME" command '{"action":"read"}'
hc --skill
herdr-app check mods/relevo
herdr-app status
```

Use the installed Herdr executable if `herdr-app` is not on PATH. `check` does not exercise deferred renders or native interaction; also try the app. A metadata snapshot and a synthetic preview are not connected agent sessions.

## Deployment and original-version rollback

Use the [installer instructions](decision-inbox.md#try-in-the-current-herdr-session). Discover the existing backup manifest locally and verify installed hashes before replacing code. For subsequent candidates, use `update` with that original backup: it retains the baseline and only writes changed files. Do not roll back and reinstall the whole candidate on every iteration. New independent installations still need a fresh backup directory; preserve existing backup chains.

```sh
# BACKUP is the verified local backup directory, not a path copied from another session.
node scripts/live-relevo.mjs verify-installed --backup "$BACKUP"
# After validating a newer candidate:
node scripts/live-relevo.mjs update --backup "$BACKUP"
# Only when intentionally restoring:
node scripts/live-relevo.mjs rollback --backup "$BACKUP"
node scripts/live-relevo.mjs verify-original --backup "$BACKUP"
```

The installer/rollback stops the local coordinator before runtime replacement and preserves agent sessions and private evidence. Inspect paused work afterward; do not assume an update restarted it. Preserve configuration and human decisions and verify them locally. Keep private manifests, absolute machine paths and state exports out of commits and PR comments.

### Runs and Reviews routing

Runs contains assignments and progress only. Reviews owns PR/local review cards, workflow results in `needs_you`, and unresolved manual decisions. `inbox-goals.js` projects these read-only queues; the run window (`workflow.js`) accepts an optional task ID and validates it belongs to the run before selecting it. Acceptance remains an explicit workflow action. Source linking, drafts, skills and addressed/Undo controls remain in Reviews. Do not restore duplicate source cards inside Runs.

### Concise review flow

Reviews no longer has summary tiles. `linkedDecision` in `lib/goal-workflow.js` derives duplicate-question suppression from an explicit question/task link and revision-matched acceptance; it never infers consent from prose or agent completion. `goals-editor.js` preserves unknown/old records and allows explicit linking or unlinking. New question text detaches an old acceptance. Run progress explains report/delivery state and prerequisites. Workflow A + Enter is a two-key acceptance intent bound to the selected task/revision; R and Command/Ctrl+Enter cover changes. Cancelling feedback restores window focus. The goal editor also saves with Command+Enter or Command+S; plain Enter remains text editing. Tests cover stale data, independent questions, input focus, acceptance progression and the isolated executor/check/reviewer/decision runtime cycle.
