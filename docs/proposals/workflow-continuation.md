# PR #40: goal and continuation guide

Read this first when continuing [PR #40](https://github.com/johnny4young/herdr-relevo/pull/40), then inspect the actual checkout, current PR head and local runtime state. Every code or documentation commit changes the checkout fingerprint; old evidence must not silently become evidence for a new revision.

## Product goal

Make Herdr's existing Inbox the place to direct and review work: understand the outcome, priority, owner, executor, review evidence, decision and what happens next without visiting every agent chat. Reduce corrections and context switching while retaining human judgment and existing security/review checks.

Preserve spaces, terminals, agents, accounts, GitHub, PRs, CI, reviews, Land, drafts, addressed work, handoffs, worktrees and the original review Inbox. Reorganize these capabilities where helpful; do not create a competing Inbox or replace the host shell. Product UI and documentation are English. Voice input should remain editable before an action is sent.

## Working agreements

- Continue in branch `feat/review-command-center` and the same draft PR. No merge or release is authorized by this handoff.
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
| One Inbox | Reviews/Missions, focus/All missions, linked PR/local work and existing actions | Keep everyday comprehension and density part of native validation. |
| Goal progress | Owner, priority, optional lead, criteria, manual steps, workflow-derived outcomes | Goal closure remains human; assigning a lead does not create a chief of staff. |
| Coordination | Durable local `hc` executor → checks → independent reviewer → human flow; bounded corrections | Automatic decomposition, global orchestration and remote checkout execution are out of scope. |
| Continuation | Acceptance advances the queue and releases already-started eligible dependents | Never start a planned task or override a stop merely because an earlier result was accepted. |
| Controls/recovery | Pause/resume/stop/cancel, attempt correlation, uncertain-send reconciliation, revision checks | Keep pause/stop regression coverage and distinguish independent source review from native end-to-end verification. |
| Review | Existing diff; explicit comment Save/Cancel/Delete; selected/all viewed controls; separate checkpoint | Verify keyboard/focus behavior through the native app, not only render tests. |
| Tools and skills | Searchable Tools and agent pickers, explicit previous-setup reuse, recipient/command preview, explicit Queue skill, task-specific message drafts | No automatic provider switching or model selection. |
| Activity | Actual assignment, delivery and report provenance; expandable prompts/logs | Do not call model routing or external-chat coordination autonomous agent delegation. |
| Evidence | Revision-bound local artifacts with hashes and quota; PR evidence references | Automatic screenshot/video production and richer archival are not implemented. |
| Preferences/input | Pending scoped preference proposals, explicit acceptance, editable system dictation, decision batches | No built-in speech capture; reduced corrections must be measured, not asserted. |
| Accessibility | Native keyboard controls, visible help/tooltips, focus-aware shortcuts | Full screen-reader acceptance remains open; native overlay accessibility needs further verification. |
| Rollback | Checksummed installer and standalone rollback launcher | Verify the selected backup really restores the original version and preserve later local edits. |

The [research record](workflow-research.md) explains the source ideas and their limits. Do not treat every proposal there as implemented.

## Normal user journey

1. Inbox → Missions → select a mission → its primary action opens Mission control. Start with Needs you. Reviews is the original queue; these UI names replace Goals/Classic without changing stored records.
2. Read Result and inspect changes/Evidence as necessary. Activity answers who assigned what; Tools contains secondary actions and configured skills.
3. Accept result, Request changes or Decide later. Acceptance records the current revision and explains the next effect. It is not GitHub approval, merge, or goal closure.
4. Already-started eligible work proceeds through an enabled coordinator. If work is stopped, blocked, missing evidence or out of budget, explain that state and the specific recovery action.
5. Accepted work stays in History. Close the goal only after its actual outcomes and outstanding decisions have been reviewed by the user.

The guiding UX question is: can the user understand what to do here and what will happen after one action? Do not solve confusion by adding more counters, explanatory paragraphs or duplicate buttons to the main card. Derive status from current records; manually written next-decision/recommendation text can become stale after acceptance and needs attention.

Task setup can explicitly reuse the latest successful setup in the same mission while retaining the new title, criteria and dependencies. Unavailable or incompatible sessions are not restored. Compact Mission control switches between Tasks and the selected work, and batch review selects entries in the existing queue rather than creating a second list. Missions without predefined outcomes show Work from brief and their actual task states instead of a misleading 0/0 counter. Finish mission is the sole closure action; accepting a task does not close the mission.

The current usability iteration derives the card's primary action from live tasks, keeps saved prose in Mission details, folds outcome progress, and offers a bounded follow-up when a settled blocked attempt has exhausted its budget. File search now exposes its result list and loading/error/empty states. Continue validating these native interactions before broadening the feature set; a render-unit test cannot prove popup sizing or screen-reader exposure.

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
| Workflow UI, Tools and Activity | `mods/relevo/workflow.js`, `lib/workflow-navigation.js` |
| Plan and completion projection | `mods/relevo/workflow-plan.js`, `lib/goal-plan.js`, `lib/goal-workflow.js` |
| Coordinator, command boundary, durable state | `mods/relevo/runtime/coordinator.mjs`, `cli.mjs`, `store.mjs` |
| Check execution, fingerprint and evidence | `mods/relevo/runtime/evidence.mjs`, `process.mjs` |
| Preferences | `mods/relevo/lib/workflow-preferences.js` |
| Diff/comment interaction | `mods/relevo/review.js` and its tests |
| Reversible deployment | `scripts/live-relevo.mjs`, `scripts/tests/live-relevo.test.mjs` |

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

Use the [installer instructions](decision-inbox.md#try-in-the-current-herdr-session). Discover the existing backup manifest locally and verify installed hashes before replacing code. Restore the previous candidate to its originals before installing a new candidate if the fresh backup must directly restore pre-PR code. Otherwise document the entire backup chain. Never overwrite a backup directory.

```sh
# BACKUP is the verified local backup directory, not a path copied from another session.
node scripts/live-relevo.mjs verify-installed --backup "$BACKUP"
# Only when intentionally restoring:
node scripts/live-relevo.mjs rollback --backup "$BACKUP"
node scripts/live-relevo.mjs verify-original --backup "$BACKUP"
```

The installer/rollback stops the local coordinator before runtime replacement and preserves agent sessions and private evidence. Inspect paused work afterward; do not assume an update restarted it. Preserve configuration and human decisions and verify them locally. Keep private manifests, absolute machine paths and state exports out of commits and PR comments.
