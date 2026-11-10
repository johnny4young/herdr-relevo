# Goal Inbox interaction

**Reviews** (previously Classic) keeps the existing review queue. **Missions** (previously Goals) organizes work by outcome and adds agent coordination. PR, review, CI, conflict, reply, draft, addressed-work and Land controls remain available. Product labels are English; user-authored content retains its original language. Stored goal records, mode preferences and command names retain their existing format.

Mission cards show the current task state and one primary action: review a result, resolve a blocker, continue paused work or plan agent work. Enter on the selected card opens that same action. Saved decision/recommendation text cannot override an active workflow's state; it remains under **Mission details**. Manual questions without a workflow remain directly actionable. **Outcomes** expands progress and manual validation; **Mission details** expands ownership, notes, criteria and attached evidence. Accepted and cancelled tasks do not inflate the open-task count.

The repository toolbar's **Find file…** is an accessible button, not an inline text field. It opens a file picker with visible loading, result-count, empty and error states. Search matches tracked and nonignored untracked file paths, with arrow keys and Enter to open a result and Escape to close. The clicked button uses its displayed repository root. Files open in the existing native file viewer.

Click Inbox to focus the queue. Arrow keys select work, Home/End reach the first/last item, G selects the next goal, F focuses it or returns to All work, and E opens context. R on a goal opens its first available linked diff; source cards select individual changes. S on a PR opens existing skill/account choices. ? shows help. Tab and Shift-Tab move between controls. Shortcuts do not act while typing in a descendant input.

The editor has Decision, Plan and Ownership sections. Fields retain edits between sections; Command-S saves them together. Recording feedback does not send it, approve a PR or validate a step automatically. Closing requires manually validated steps and no pending decision.

Use **Decision & next steps** to save a local review note and explicitly resolve a pending question. Resolving retains the question in the history. **Validate steps** on the card opens Plan directly; validate individual outcomes or use **Validate all steps** after reviewing them. **Save** applies progress, while **Save and finish goal** also closes a fully validated, resolved goal. Request further work through **Send to agent** in Review or **Message lead** in Inbox.

Review comments have a persistent editor below the diff with **Save comment**, **Cancel** and **Delete comment**. Enter saves; Escape cancels the edit and retains the previously saved comment. Empty text does not delete implicitly. **Mark file viewed** applies to the selected file and **Mark all viewed** applies to the displayed review; a content change resets that file's viewed mark. **Save checkpoint** separately sets the baseline for **Since I looked**.

Focus is a view filter, not an agent assignment. Lead identifies an existing agent; observed children do not establish task ownership. Review scope controls select working-tree, branch or previously viewed changes.

Session names, private project metadata, screenshots, private research notes and exercise results belong outside the repository. Public sources and design decisions are in the [research record](workflow-research.md). See [installation and rollback](decision-inbox.md) for operational instructions.
