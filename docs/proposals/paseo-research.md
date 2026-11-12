# Paseo: useful patterns for Relevo

*A research record, kept as written. It uses Goals or Missions for what the UI now calls runs, and some ideas here were later built or dropped; [how runs work](workflow-runtime.md) describes current behavior.*

Reviewed on 2026-11-10 for [PR #40](https://github.com/johnny4young/herdr-relevo/pull/40). Scope: official documentation, the public website's Parallel agents / Code review / Pull requests previews, and selected source at [11d7267](https://github.com/getpaseo/paseo/tree/11d7267e3311ec7e90bf52e82df1d098f9ea309c). The website previews illustrate the product; they are not a connected agent session. Paseo was not installed or benchmarked. This is comparative research, not a complete usability or accessibility audit.

## What fits this goal

Relevo should make the next human decision obvious while preserving Herdr's existing sessions, source review and GitHub workflow. Paseo is a useful reference for keeping that context together and reducing repeated setup. Its mobile client and provider launch controls depend on infrastructure Relevo does not currently have.

| Pattern and evidence | Apply to Relevo | Priority / current status |
| --- | --- | --- |
| The [published workspace previews](https://paseo.sh/) group attention by readiness and keep conversation, changes and PR state beside each other. | Keep Needs you first and existing Result/Evidence routes. Use compact status, with detailed reports on demand. Avoid another Inbox or another set of PR controls. | Preserve the current queue; continue simplifying its first screen. |
| The [check summary source](https://github.com/getpaseo/paseo/blob/11d7267e3311ec7e90bf52e82df1d098f9ea309c/packages/app/src/components/sidebar/workspace-meta-row/check-summary.ts) gives failure precedence over progress. | Compare recorded check results with configured checks. Distinguish not configured, not run, incomplete and failed. Do not present prior results as the new implementation round's checks. | Implemented in this iteration's Mission CHECKS summary. This changes presentation, not acceptance rules or execution. |
| [Agent profiles](https://paseo.sh/docs/agent-profiles) combine settings and explain when to use them; edits affect future selections. | Reuse repository and role/check choices while keeping the new brief intact. | Implemented as locally saved, repository-scoped setups. Applying one only fills the form; review the settings and explicitly create/start. It does not dispatch work or choose a model/provider. |
| [Parallel development](https://paseo.sh/docs/parallel-development) pairs independent writers with separate worktrees and keeps review close to changes. | Offer existing checkout versus isolated worktree only when starting independent writes. Keep the reviewer on the same result revision; show branch, checks and diff together. | Existing worktree actions stay available. Automatic per-task worktree creation/cleanup remains proposed. |
| [Orchestration](https://paseo.sh/docs/orchestration) exposes workers and completion to the parent; enabling injected tools is an explicit capability. | Keep Activity's actual assignment → delivery → report → decision trail. A lead is useful when it reduces handoffs; no permanent extra agent is needed for deterministic transitions. | Existing coordinator covers bounded local executor/reviewer handoffs. Cross-machine orchestration is not part of this PR. |
| [Attention source](https://github.com/getpaseo/paseo/blob/11d7267e3311ec7e90bf52e82df1d098f9ea309c/packages/app/src/utils/agent-attention.ts) treats permission attention differently from ordinary completion attention. | Preserve the distinction between viewed, reviewed and accepted. Opening a result must not accept it, approve a PR or clear required intervention. | Keep existing explicit decisions and diff viewed controls. Do not adopt focus-to-dismiss for pending human decisions. |
| [Shortcut search tests](https://github.com/getpaseo/paseo/blob/11d7267e3311ec7e90bf52e82df1d098f9ea309c/packages/app/src/keyboard/shortcut-help-search.test.ts) cover action names, modifier aliases and remapped bindings. | Make shortcut help searchable from the effective keymap, including actions with no assigned key. Avoid a second list of hard-coded defaults. | Implemented as searchable fixed-window action help with the effective shortcuts and modifier aliases. Inbox actions include selection, open, return focus and numbered choices; Relevo commands remain discoverable in the same help surface. |
| [Draft controls](https://github.com/getpaseo/paseo/blob/11d7267e3311ec7e90bf52e82df1d098f9ea309c/packages/app/src/composer/draft/input-draft-core.ts) scope draft identity to its owning context. | Recover an unsent task brief only for the matching mission/repository, then revalidate connected agents. | Implemented as local per-mission draft recovery with explicit Resume and Discard. Resume rechecks live agent/root availability and warns about missing prerequisites; it does not start work. |
| [Voice documentation](https://paseo.sh/docs/voice) separates dictation, conversation and optional speech providers. | Keep any future voice input editable and explicit before dispatch. | No dedicated voice workflow is implemented. No mobile workflow or automatic per-task worktree creation is implemented; existing manual worktree actions remain available. |

## A simpler intended journey

1. **Open Missions:** see what is ready for a decision and what is still working.
2. **Review one result:** read a short summary, check truthful test/review state, open the existing diff or evidence when needed.
3. **Decide:** accept, request a bounded correction, or defer. Viewing and acceptance stay distinct.
4. **Continue:** eligible work proceeds through the existing coordinator; stopped or unstarted work stays stopped or unstarted.
5. **Start similar work:** explicitly apply a saved setup for the same repository, change the brief as needed, review roles/checks/limits, then explicitly create or start the task. Applying the setup alone does not dispatch work.

## What not to add now

Do not duplicate Herdr's terminals, editor, PR actions or accounts. Do not add a mobile relay, automatic worktree creation, a dedicated voice workflow, always-running chief of staff, hidden voice agent, heartbeat loop, automatic provider switching or a plugin marketplace merely to match a feature list. These need separate product evidence and operational boundaries. A small, understandable decision queue is the priority.

For saved setups, preserve the new brief, recheck session availability, leave running tasks untouched and make limits visible before creation. For isolation, validate branch ownership and cleanup before adding automatic worktree creation. For UI, measure locally how quickly a person identifies the next action, how many agent-chat switches are required, and how often corrections repeat. No comparative superiority or reduced cost has been demonstrated.
