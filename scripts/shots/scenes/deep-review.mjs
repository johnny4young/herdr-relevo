// A deep review of a PR and the fix run it handed its findings to; VIEW=fix opens the fix, with findings marked. Demo names only.
export default async function scene({ fake, cx, flush, load }) {
  const { newGoal, saveGoal, emptyGoals } = await load("mods/relevo/lib/goals.js");
  const { goalsPath } = await load("mods/relevo/goals-store.js");
  const { GOAL_MODE } = await load("mods/relevo/inbox-goals.js");
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const pr = { url: "https://github.com/acme/billing/pull/42", number: 42, headRef: "feat/retry-payments", clone: "/home/demo/code/billing", head: "4f1c2a9".padEnd(40, "0") };
  const nav = { level: "major", where: "src/payments/retry.js:41", issue: "A failed charge is retried after the card was replaced, so the old card is charged again", fix: "Read the card on each retry", proof: "retry.js:41 keeps the card from the first attempt" };
  const legend = { level: "major", where: "src/payments/ledger.js:88", issue: "Refunds of retried charges are counted twice in the daily total", fix: "Key the ledger by charge id" };
  const minor = { level: "minor", where: "src/payments/retry.test.js:12", issue: "The test name says success but it checks a decline", fix: "Rename it" };
  const said = (id, label, findings, m) => ({ id, goalId: "rv", title: `${label} · #42 Retry failed payments`, state: "accepted", root: `/home/demo/.herdr/worktrees/billing/review-42-${id}`,
    executor: null, reviewer: { address: id, label }, reviewOnly: true, pr, round: 0, maxRounds: 1, revision: `rev-${id}`,
    attempts: [{ id: `a-${id}`, role: "reviewer", state: "reported", at: ago(m), report: { status: "changes_requested", summary: `${findings.length} to fix before merging`, findings } }] });
  const reviews = [said("r1", "Team · opus high", [nav, legend, minor], 64), said("r2", "Team · sonnet high", [{ ...nav, issue: "The retry keeps the first card, so a replaced card is never used" }], 62)];
  if (process.env.VIEW !== "fix") reviews.forEach((r) => { r.state = "needs_you"; });
  const wt = { path: "/home/demo/.herdr/worktrees/billing/fix-42-deep-review-9c1d2e", branch: "run/fix-42-deep-review-9c1d2e", base: "/home/demo/code/billing",
    baseCommit: "a".repeat(40), reviewedTree: "b".repeat(40), prHead: pr.headRef, prUrl: pr.url };
  const fix = { id: "fx", goalId: "fx", title: "Fix #42 · deep review", state: "needs_you", root: wt.path, worktree: wt, revision: "rev-fx", round: 1, maxRounds: 2,
    executor: { address: "w1", label: "Team" }, reviewer: { address: "r3", label: "Codex" }, checks: [["npm", "test"]], checksResult: [{ argv: ["npm", "test"], code: 0 }],
    attempts: [{ id: "w", role: "executor", state: "reported", at: ago(26), report: { status: "completed", summary: "Retries read the card again, and a test covers a card replaced between attempts.",
      details: ["Fixed: src/payments/retry.js:41 — reads the card on each retry", "Fixed: src/payments/retry.test.js:12 — renamed"] } },
    { id: "v", role: "reviewer", state: "reported", at: ago(15), report: { status: "completed", summary: "", findings: [{ level: "minor", where: "src/payments/retry.js:52", issue: "The backoff is a magic number", fix: "Name it" }] } }] };
  const goals = [Object.assign(newGoal("rv", "Deep review · billing #42 · 4f1c2a9"), { criteria: "Review pull request #42 as a whole." }),
    Object.assign(newGoal("fx", "Fix #42 · deep review"), { from: "rv" })];
  const change = { taskId: "fx", root: wt.base, fromCommit: wt.baseCommit, toCommit: wt.reviewedTree, files: 2, added: 31, removed: 6,
    list: [{ path: "src/payments/retry.js", added: 19, removed: 6 }, { path: "src/payments/retry.test.js", added: 12, removed: 0 }] };
  fake.files[goalsPath()] = JSON.stringify(goals.reduce((doc, g) => saveGoal(doc, g, 0), emptyGoals()));
  fake.files["/home/demo/.config/herdr-app/relevo-workflow/state.json"] = JSON.stringify({ tasks: [...reviews, ...(process.env.VIEW === "fix" ? [fix] : [])], events: [], engine: { enabled: true } });
  const none = { data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } }, search: { nodes: [] } } };
  const orig = fake.exec;
  fake.exec = (cmd, args, o) => (cmd === "gh" && args[0] === "api" ? { stdout: JSON.stringify(none) }
    : /cli\.mjs$/.test(args?.[0] ?? "") && args.at(-1).includes('"task-diff"') ? { code: 0, stdout: JSON.stringify({ result: change }) } : orig?.(cmd, args, o) ?? null);
  const { Inbox } = await load("mods/relevo/inbox.js");
  const inbox = new Inbox();
  inbox.init({}, cx);
  await flush();
  fake.stored[GOAL_MODE] = true;
  inbox.h.is_focused = () => true;
  inbox.render(cx);
  const fixing = process.env.VIEW === "fix", goal = inbox.goalDoc.goals.find((g) => g.id === (fixing ? "fx" : "rv"));
  inbox.openRun(goal, cx); inbox.render(cx);
  inbox.resetRun(fixing ? "fx" : "r1"); inbox.render(cx); await flush(); inbox.render(cx);
  if (fixing) {
    const task = inbox.workflowTasks.find((x) => x.id === "fx");
    inbox.togglePicks(task, [legend], cx);
  }
  return { el: inbox.render(cx), width: 420, height: 760 };
}
