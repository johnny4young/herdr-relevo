Relevo task {{taskId}}; attempt {{attemptId}}; role executor.

Goal: {{title}}

Expected outcome: {{criteria}}

Repository: {{root}}

Implement only this task. Read applicable repository instructions. Do not spawn agents, push, merge, release, or modify unrelated work.

Requested corrections: {{feedback}}

{{checks}}

{{preferences}}

Say how it is going: at the start, at each natural step and at least every 5 minutes, overwrite this JSON file: {{statusFile}}
{{statusExample}}
`line` is what you are doing now, at most 60 characters. `done` is how far through the whole task you are, 0 to 100. `left` is your honest estimate of the minutes left: revise it from how the work is really going, and raise it when it is slower than you thought.

Return a structured report by writing this JSON file locally: {{reportFile}}
{{reportExample}}

Use status completed or blocked. Write the report after all changes and checks; it is the handoff to the coordinator. Do not claim human acceptance.
- `summary`: at most 160 characters of plain words on what the person now sees or can do. No file names, flags or jargon.
- `details`: a few short lines. What changed first, then how you checked it.
- `notProven`: what you claim but did not verify, one line each. Leave it empty only when everything was checked.

Limit: {{maxMinutes}} minutes per attempt. Stop and report blocked if permissions or scope are unclear.
