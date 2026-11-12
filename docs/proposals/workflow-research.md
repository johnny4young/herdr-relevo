# Workflow research and design decisions

*A research record, kept as written. It uses Goals or Missions for what the UI now calls runs, and some ideas here were later built or dropped; [how runs work](workflow-runtime.md) describes current behavior.*

Research collected on 2026-11-09; consolidated on 2026-11-10 for [PR #40](https://github.com/johnny4young/herdr-relevo/pull/40). This combines documentary research, a bounded source review and product reasoning, not a comparative hands-on benchmark. The supplied tier image selected the 16 products below (B and above); its ranks are personal opinions, not evidence of quality. No competing product needs to be installed to continue this PR.

The application column records our design inference. Implementation status belongs to the [continuation guide](workflow-continuation.md) and the code, not to a competitor's feature list. Sources can change; preserve the distinction between historical research and newly verified capabilities.

## Product references

| Reference from the selected tier list | Research theme | Application to Relevo |
| --- | --- | --- |
| [T3 Code: thread sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) | Parent context, agent threads, active versus settled work | Explain who assigned work, to whom, and what remains pending inside Activity. |
| [Omnigent: built-in agents](https://omnigent.ai/docs/use/builtin-agents) | Decomposition and cross-agent review | Explicit executor/reviewer roles and bounded correction rounds; no automatic human acceptance. |
| [Paseo](https://github.com/getpaseo/paseo) | Contextual review, profiles, truthful status, drafts and keyboard discovery | [Focused follow-up](paseo-research.md) compares pinned source and published previews; adopts failure-first check summaries, local draft recovery, repository-scoped setup reuse and searchable shortcut help. |
| [OnOrca: orchestration](https://www.onorca.dev/docs/cli/orchestration) | Runs, tasks, dispatches and messages | Correlate every report with its attempt; reject late or mismatched reports. The focused follow-up below includes directly inspected source and availability limits. |
| [Agent Orchestrator](https://orchestrator.inc/) | Agent supervision alongside branches, reviews and CI | Keep intervention, PR and CI context connected to work. |
| [CodexHost](https://github.com/BytePioneer-AI/codex-host) | Harness collaboration within an existing interface | Preserve the host shell and actions; do not adopt patches to another application's internals. |
| [Hermes: Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) | Durable tasks, workers and handoffs | Store task/attempt state independently of terminal text; recover without duplicate sends. |
| [Superset](https://superset.sh/) / [Paradev](https://paradev.com/) | Parallel workspaces and automation | Isolate independent writers and bring changes and review together. The earlier notes followed Superset to Paradev; verify current naming rather than assuming equivalence. |
| [Oh My Pi / OMP](https://omp.sh/docs) | Resumable sessions, plans, handoffs, subagents and extensibility | Put contextual tools beside the task; keep full prompts and technical output expandable. |
| [Traycer: agent-to-agent](https://docs.traycer.ai/concepts/agent-to-agent) | Task context across agents and hosts | Retain assignments, findings and decisions in the task's history. |
| [Conductor](https://www.conductor.build/docs) | Workspace, branch, terminal, diff and review journey | A complete start → inspect → decide → archive flow using the existing review surface. |
| [OpenCodeX](https://opencodex.me/guides/sub-agent-surface/) | Model/effort and collaboration surfaces | Keep role/model policy separate from dispatch logic. This reference is not OpenCode or official Codex. |
| [bb](https://getbb.app/claude-code-and-codex) | Visible cross-provider review threads | Inspect the actual assignment and response without requiring a chat switch. |
| [Pi](https://pi.dev/) | Skills, templates, session trees and follow-ups | Explicit contextual skills and distinct queued/immediate messages; do not assume subagents exist by default. |
| [HarnessRouter](https://harnessrouter.ai/docs) | Execution/session/artifact contracts | Keep the runtime boundary provider-independent; avoid adding an unnecessary external service. |
| [Maestri: connections](https://www.themaestri.app/en/docs/connections) | Visible agent connections | Show real communication relationships. A dependency graph is optional detail, not the main decision surface. |

## T3 Code: specific ideas to retain

- [Thread sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md): visible agent context. Relevo must distinguish an observed parent, an assigned role and its own coordinator; those are different facts.
- [Keybindings](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md): discoverable actions and follow-up controls. Relevo separates Queue follow-up from Send now, respects input focus and exposes shortcuts through help.
- [Architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md): record intent before effects. Relevo persists attempts before `hc` delivery and distinguishes acknowledgement, report, checks and acceptance.
- [Source control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md): guided review and pending comments. Relevo reuses its diff and keeps comment editing/cancellation/deletion explicit.
- [Outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md): explicit external-agent interfaces. Relevo already uses `hc`; this is not a reason to install another orchestrator.

These references do not establish the exact feature set of the Nightly build pictured in the original tier image.

## Focused T3 Code and Orca source review

The follow-up inspected representative current `main` source files and official product documentation. Neither competing application was installed or exercised end to end. Source links are moving references; this is a bounded flow review, not a complete architecture/security audit or proof of comparative usability.

| Verified source | Pattern to retain in Relevo |
| --- | --- |
| T3 Code [`_chat.index.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/routes/_chat.index.tsx), [`ThreadRouteView.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ThreadRouteView.tsx) | Prompt-ready entry and persistent conversation context. A mission should open on useful work and preserve drafts across auxiliary views. |
| T3 Code [`Sidebar.logic.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.logic.ts), [`useComposerSend.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/useComposerSend.ts) | Lifecycle-based navigation and draft recovery. Consolidate destinations; preserve distinct save/start/accept effects. |
| T3 Code [`pullRequestDetail.logic.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/pullRequest/pullRequestDetail.logic.ts), [`NewThreadLinkView.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/promptLinks/NewThreadLinkView.tsx) | State-dependent primary actions and an explicit checkout/setup boundary. Keep PR controls connected to the task and explain consequences before execution. |
| Orca [`OrchestrationCrewPanel.tsx`](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/orchestration-crew/OrchestrationCrewPanel.tsx), [`CrewRowView.tsx`](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/orchestration-crew/CrewRowView.tsx) | Compact worker status with expandable relationships, messages and session access. Show the next decision first; retain provenance in Activity. Source presence does not establish availability in every released build. |
| Orca [`run-create.ts`](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/runs/run-create.ts), [`task-store.ts`](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/tasks/task-store.ts) | Durable objectives, coordinator identities and dependency gates already exist there. Having a coordinator or DAG alone is not a Relevo differentiator. |
| Orca [`NewWorkspaceComposerCard.tsx`](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/NewWorkspaceComposerCard.tsx), [`WorktreeCreationPanel.tsx`](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/worktree-creation/WorktreeCreationPanel.tsx) | Contextual project/host/agent/base selection and visible background creation, cancel and retry. Optional isolated-worktree execution is a future Relevo capability, not implemented by this PR. |

Orca's [orchestration documentation](https://www.onorca.dev/docs/cli/orchestration) currently calls the feature experimental and describes CLI-first operation while its experimental panel/switch are unavailable. Its [worktree documentation](https://www.onorca.dev/docs/model/worktrees) provides the public create → work → review → ship lifecycle. Do not confuse these availability notes with the presence of source components.

### Mission objectives and acceptance measures

The target is a better fit for outcome-driven, batch-reviewed work. Superiority to either product has not been demonstrated.

| Objective | Observable acceptance criterion | Current boundary |
| --- | --- | --- |
| Know what needs attention | On opening a mission, identify its result, current state and next action without opening an agent chat. | Live primary action and ready-review ordering are implemented; comprehension must be checked with real use. |
| Delegate without repeated setup | Enter an outcome, select the repository and roles, then explicitly start. Advanced controls stay optional. | Brief, searchable agents, check presets and local repository-scoped setup profiles are implemented. Applying a setup fills the form only; the user reviews and explicitly creates/starts work. No model/provider routing is included. |
| Review a complete result | Reach changes, checks, independent review and evidence from the same task; distinguish missing evidence from success. | Result/Evidence and revision guards exist; automatic screenshot/video capture remains proposed. |
| Continue without manual handoffs | An accepted result releases eligible already-started work, while stops and human review boundaries remain intact. | Supported for local connected sessions; automatic goal decomposition is not implemented. |
| Preserve familiar development work | Reach existing GitHub, PR, diff, review and terminal actions without duplicate workflow controls. | Existing surfaces are retained; accepting a mission result never implies PR approval or merge. |
| Work efficiently by keyboard | Discover shortcuts, navigate the common path and cancel editing without losing unrelated work. | Searchable fixed-window shortcut help shows effective bindings, modifier aliases and Inbox actions; native input names and full screen-reader acceptance remain open. |

Compare repeated, equivalent tasks using time to understand the next action, manual handoffs, chat switches, corrections and cost per accepted outcome. Keep traces and results local. Automatic worktree creation, dedicated voice/mobile workflows and model/provider routing are not implemented; do not imply that saved setup profiles perform those functions.

## Herdr + OMP + Magpie references

The supplied [first demo post](https://x.com/lexrus/status/2118202178406072403) and [second demo post](https://x.com/lexrus/status/2119443089760960679) are retained as inspiration. Both returned HTTP 403 when reopened for this handoff, so the videos were not independently reverified here. Do not describe unseen interactions as tested capabilities.

[OMP documentation](https://omp.sh/docs) describes contextual coding tools, sessions and extensibility. [Magpie's repository](https://github.com/yetone/magpie) describes a local model/account gateway. Model routing is distinct from task delegation, review and acceptance. The useful Relevo inference is a searchable Tools surface with a visible command, recipient and explicit send. This PR does not install Magpie/OMP, change provider credentials or add automatic model/account switching.

## UX references and resulting decisions

| Source | Relevo decision |
| --- | --- |
| [NN/g: visibility of system status](https://www.nngroup.com/articles/visibility-system-status/) | Explain what changed after a decision, what is running, and why something is blocked. |
| [GOV.UK: confirmation pages](https://design-system.service.gov.uk/patterns/confirmation-pages/) | Confirm acceptance and explain continuation instead of presenting an unexplained Next step button. |
| [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Show outcome and primary decision first; fold setup, limits, prompts and technical events. |
| [GOV.UK: task list](https://design-system.service.gov.uk/components/task-list/) | Distinguish pending, running and completed work; keep history accessible. |
| [Apple: keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards/) and [WAI-ARIA keyboard practices](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) | Predictable focus, Escape, Tab and shortcuts; essential instructions must also be visible. ARIA is a behavioral reference, not an implementation claim for this native app. |
| [Linear Inbox](https://linear.app/docs/inbox) | Prioritize attention while retaining All work and a clear route back from goal focus. |
| [Cursor Agent Review](https://cursor.com/docs/agent/agent-review) | Treat independent review as a separate stage before human acceptance. |
| [Codex app introduction](https://openai.com/index/introducing-the-codex-app/) | Keep parallel work, worktrees, diff review and skills in one working environment. |

## When leads and a coordinator are useful

Use a reusable lead when an area benefits from persistent context. Use workers for independent bounded tasks and an independent reviewer where the change warrants it. Add a cross-goal coordinator only when real dependencies or resource conflicts justify the extra layer. Deterministic transitions should remain code, not additional model turns.

This is our recommendation, informed in part by [Anthropic's multi-agent research account](https://www.anthropic.com/research/multi-agent-research-system), which discusses both benefits and coordination costs. It is not proof that a permanent hierarchy improves every coding task. No always-busy agents, guaranteed monetary cap or autonomous human judgment is implied.

Measure improvement locally over repeated use: time to understand the next action, chat switches, corrections per accepted change, duplicate sends, recovery without loss and cost per accepted outcome. Do not infer success from a single demonstration. Private project names, artifacts, session transcripts and exercise results remain local.
