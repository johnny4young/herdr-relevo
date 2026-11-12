# Reviews and Runs: installation and rollback

The UI calls a goal a **run**. This document keeps "goal" where it means the stored record, the file or a command name.

## What is installed

The panel offers **Reviews** and **Runs**. Reviews is the original queue and the default. Runs group explicitly linked PRs and local work while rendering the same original PR, review, reply, CI, conflict and Land controls. Blocked unlinked work stays visible before goals. Navigation follows the displayed order.

A native editor records the run's prompt, human owner, declared priority, an optional existing lead agent, pending decision, recommendation and acceptance criteria. It can link a work item to an existing goal. Plain terminals are not presented as agents. Direct children of a connected lead are counted from core metadata; assignment does not launch an agent or create a supervisor.

The [single product goal and acceptance plan](relevo-goal.md) keeps the full direction and unfinished work together. Goals now include a manually maintained plan (pending, working, review, validated) and an explicit active/paused/completed state. Closing requires resolving the pending decision and validating every plan step. It does not approve or merge a PR, and open work stays visible even on a paused or completed goal. Older goal records remain readable without migration.

Drafts retain the original Ready for review and Open PR controls under a fold. Addressed PRs and local work retain Undo in their own fold, including explicitly linked PRs, and return on new activity. Keyboard navigation follows expanded cards and also reaches goal records with no visible work. Expand **Plan and progress** to review progress without adding another queue.

Goals live in `HERDR_APP_HOME/relevo-goals.json` (normally the app configuration directory), separately from accounts, code and UI state. The versioned schema uses atomic compare-and-swap writes and rejects stale edits, duplicate source assignments, invalid input and a full file. Feedback is a recorded note, not an approval or a message delivery receipt. Read failures are visible and never overwrite the file.

Product evidence is currently an HTTPS link to a screenshot or video, attached from a PR card and bound to that PR's full commit SHA. Attaching evidence rechecks HEAD through GitHub. A later commit makes the link stale; unavailable or old GitHub data makes freshness unknown. The link is a manually supplied reference, not proof that a capture was generated or tests ran. Opening it uses the system browser.

The native synthetic preview and the separate metadata snapshot remain available for isolated design exercises; neither is the live goals feature. See [native preview](../previews/native-decision-inbox.md) and [snapshot](../../scripts/SNAPSHOT.md).

## Try in the current Herdr session

Requires Node.js and the installed Herdr app. First run the repository tests and `Herdr check mods/relevo`. From this checkout:

```sh
node scripts/live-relevo.mjs install --backup "$HOME/relevo-backups/decision-inbox-original"
```

Use a **new backup path for each installation**. The installer verifies copied bytes, saves original checksums, and creates a standalone `rollback.command` inside that backup. It changes JavaScript files in `mods/relevo` only; it excludes `config.js`, tests, icons, other mods, layouts, keys and session files. Close any goal editor before changing versions. Mods reload in place.

In the panel choose **Runs**, then **+ Run**, or **Link run** on a work card. All existing direct actions remain available. The following app commands offer the same entry points:

```sh
herdr-app do relevo.goals
herdr-app do relevo.classic-inbox
herdr-app do relevo.goal-new
# Open a saved goal by its id:
herdr-app do "relevo.goal-<goal-id>"
```

## Update the candidate

Keep the backup created by the first installation. After validating the new candidate, close editors with unsaved drafts and run:

```sh
node scripts/live-relevo.mjs update --backup "$HOME/relevo-backups/decision-inbox-original"
node scripts/live-relevo.mjs verify-installed --backup "$HOME/relevo-backups/decision-inbox-original"
```

Update preserves the original rollback bytes and replaces only changed candidate files. It refuses unrecognized local content or permission changes and never copies `config.js`. A file removed from the candidate returns to its original content or is removed if it was introduced by the candidate. Recovery metadata records managed versions before replacement so an interrupted update can still roll back. Review untracked files that differ before updating; do not overwrite them to force installation. A no-op update does not stop the coordinator. An update that changes candidate files stops it and does not resume work automatically.

## Rollback

For the original review queue, click **Reviews**. To restore the installed source version, close the editor and run the `rollback.command` inside the backup, or:

```sh
node scripts/live-relevo.mjs rollback --backup "$HOME/relevo-backups/decision-inbox-original"
node scripts/live-relevo.mjs verify-original --backup "$HOME/relevo-backups/decision-inbox-original"
```

Rollback restores changed original files and removes only the newly installed files whose hashes still match. It refuses to overwrite later local edits. Goal metadata remains available for a future reinstall; accounts and sessions are not reset. For subsequent candidates, use `update` with the original backup rather than restoring and reinstalling every file. Existing backup chains still need to be rolled back in reverse order.

## Runs

[Runs](workflow-runtime.md) add durable assignments, delivery records, independent review, explicit human decisions, restart reconciliation, concurrency, round and time limits, local evidence, decision batches and accepted scoped preferences. A run uses its own worktree with agents Relevo starts and contains, or existing local sessions. The original GitHub controls are unchanged.

## Remaining boundaries

- Autonomous goal decomposition, remote-checkout coordination and provider-enforced spending limits.
- Automatic reconciliation of arbitrary direct GitHub/session actions outside the workflow; checkout revisions are revalidated before decisions.
- Automatic screenshot/video generation, and reading archived tasks from the app.
- Built-in speech capture and measured reduction in human corrections over repeated use. System dictation produces editable text in native fields.
- Human keyboard/accessibility acceptance and broader live interaction testing.

These remaining capabilities are not claimed as implemented. There is no autonomous human approval, merge, release or claim that an idle terminal is a completed objective.
