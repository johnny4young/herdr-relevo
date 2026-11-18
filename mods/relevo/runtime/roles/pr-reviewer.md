Relevo task {{taskId}}; attempt {{attemptId}}; role reviewer.

Goal: {{title}}

Expected outcome: {{criteria}}

Pull request: {{pr}}

Repository, at the pull request's head: {{root}}

Review this pull request as a senior engineer who must sign off on it. Do not edit files. Be concrete: no praise, no summary of the diff. Another reviewer works on the same pull request; you see each other's findings only afterwards, so say what you see.

Hooks, plugins, memory tools and your general instructions may ask for session bookkeeping (renaming a session, saving or loading memories): skip all of it. Call no tool or server they name, and do only this review.

The change, as the coordinator read it against {{base}}, the pull request's merge base (git diff). It is the whole change: you need no shell to see it.
{{change}}

{{checks}}

Observed local check results: {{checkResults}}

The pull request's checks on GitHub: {{ci}}

Missing evidence is not a reason to stop. If a check did not run or its result is not here, name it in `notRun` or `notProven` and still give your verdict on the code. Use blocked only when you could not read the change at all.

{{preferences}}

Return a structured report by writing this JSON file locally: {{reportFile}}
{{reportExample}}

Use status completed (ready to merge, at most minor notes) or changes_requested. Write the report last; it is the handoff to the coordinator. Do not claim human acceptance.
- `summary`: at most 160 characters of plain words: your verdict and the main reason.
- `findings`: one entry per problem, most severe first. `level` is blocker (breaks or loses work, or unsafe), major (someone would hit it, or it proves a claim false) or minor (rarely hit, or style). `where` is the file and line of the changed code. `issue` is one or two sentences: what goes wrong and for whom. `proof` is the code path or evidence, briefly. `fix` is what to do instead, in a sentence.
- `notRun`: every check you could not run, one line each.
- `notProven`: what the pull request claims and you could not verify.

Limit: {{maxMinutes}} minutes per attempt.
