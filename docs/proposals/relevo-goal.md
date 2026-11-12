# Goal: direct and review work from one Inbox

Bring existing PRs, local work and human decisions together while preserving Herdr spaces, terminals, accounts and Relevo review actions.

The UI calls a goal a **run**; the stored record is still a goal. A goal records an expected outcome, owner, priority, optional existing lead, linked work, criteria and plan. Step states are Pending, In progress, Needs review and Validated. Goal states are explicit; inactive terminals and addressed cards do not establish completion.

## Current scope

- **Reviews** and **Runs** share existing work and actions.
- Focus isolates a run's linked work, with All runs restoring the queue.
- Draft and addressed work remain available through folds.
- Revision-bound evidence links and feedback are separate from approvals.
- Version checks protect saved edits from stale writers.
- File-scoped installation provides rollback without resetting accounts or sessions.

## Built on top

[Runs](workflow-runtime.md) add explicit task ownership, coordinator dispatch, delivery records, restart reconciliation, round and time limits, local evidence bound to a fingerprint, batches, accepted scoped preferences, a worktree per run with a commit of the reviewed tree, sandboxed run agents and an archive. Assigning a lead alone does not start execution.

## Further work

Automatic goal decomposition, provider-enforced money budgets, automatic visual artifact generation and built-in speech capture remain outside this increment; native text fields support system dictation.

Public research and design rationale are collected in the [research record](workflow-research.md). Keep private work logs, named project examples, session artifacts and exercise results local. The [continuation guide](workflow-continuation.md) records the goal, implementation boundaries and next engineering steps for another session.

See [interaction](goal-ux.md) and [installation](decision-inbox.md).
