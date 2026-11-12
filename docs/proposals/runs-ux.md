# Runs and Accounts interaction

This document records the implemented simplification for starting and following agent work. Validate it in the installed native app as well as through regression tests; render tests alone do not establish popup sizing or accessibility.

## Current change

**Reviews** and **Runs** are direct top-level destinations. Runs does not add another Inbox header or nested navigation layer. Starting a run begins with one prompt. The focused repository is suggested, with an explicit change control. Connected executor/reviewer choices are then shown explicitly, with a clear preview before the person creates or starts work. Existing plans remain available behind a detail view instead of competing with the prompt on the first screen. The queue stays compact and shows each run's current action; opening it reveals its details.

**Accounts** keeps status at a glance: an icon and a usage circle in five-percentage-point segments for the account's tightest window, five-hour or weekly, with the value next to it from 80% and the exact reading in its tooltip. Clicking an account opens its popup with weekly usage details. Unknown or stale usage is labeled as unknown or stale rather than appearing current.

Reusable setups are available for the same run and repository. Applying one fills the form but preserves the new prompt; it does not start a run, and the repository and connected agents remain reviewable before creation.

These choices follow the same intent as the run editor: surface the next decision first, keep setup explicit, and retain detail on demand. Paseo's [parallel-development guide](https://paseo.sh/docs/parallel-development) describes separate workspaces for independent tasks and keeping review close to each workspace. T3 Code's [thread sidebar guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) documents a focused active-thread list with working threads folded into a separate section. These are references for patterns, not claims about equivalent implementation or measured outcomes in Relevo. Related research is in the [research record](paseo-research.md).

## Built since this was written

- **Isolated workspaces.** A run gets its own worktree by default, with a `run/<slug>` branch, a commit of the reviewed tree on acceptance, a draft PR and explicit cleanup. See [how runs work](workflow-runtime.md#worktree-runs).
- **A run as a pane.** A run opens beside the work instead of over it, with the decision fixed at the bottom.

## Separate follow-up ideas

The following are not part of the current UI:

- A broader overview that groups runs as running, completed or needing attention.
- More coordinator transparency, showing actual assignment, handoffs, reports and human decisions without inventing agent activity.
- A way to read archived tasks from the app; today they are only in `relevo-workflow/archive/`.

Each idea needs its own design and validation. It should not add a second queue, duplicate existing review controls, or start work implicitly.

## Reversible layout update

The default layout removes the sidebar account block and adds its status-bar role without replacing the native workspace status controls. `scripts/relevo-layout.mjs` can apply the same narrow migration to an installed personal Relevo layout. It preserves unrelated nodes and wider customized navigation sizes, refuses unfamiliar account/status integrations, saves the first layout bytes, and rejects rollback over unrelated later edits. Layout rollback is separate from the JavaScript-only `live-relevo.mjs` manifest; combine both in a local launcher when deploying this change. Never reset user settings, credentials, sessions or goal records.
