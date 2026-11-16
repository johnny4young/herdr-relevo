// The Runs view with demo goals and tasks; RUN=g1 opens a run, TASK=<id> opens a task. Demo names only.
export default async function scene({ fake, cx, flush, load }) {
  const { newGoal, saveGoal, emptyGoals } = await load("mods/relevo/lib/goals.js");
  const { goalsPath } = await load("mods/relevo/goals-store.js");
  const { GOAL_MODE } = await load("mods/relevo/inbox-goals.js");
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const writer = { address: "w1", label: "Codex" }, reviewer = { address: "r1", label: "Haiku" };
  const wrote = (s, m) => ({ id: `a-${m}`, role: "executor", state: "reported", at: ago(m), report: { status: "completed", summary: s } });
  const reviewed = (status, m, extra = {}) => ({ id: `r-${m}`, role: "reviewer", state: "reported", at: ago(m), report: { status, summary: "", ...extra } });
  const task = (id, goalId, title, state, more = {}) => ({ id, goalId, title, state, root: "/home/demo/code/billing", executor: writer, reviewer, round: 1, maxRounds: 2, ...more });
  const ready = (id, goalId, title, m) => task(id, goalId, title, "needs_you", { revision: `rev-${id}`, attempts: [wrote("Ready results now sort ahead of failed ones, so a decision that waits on you is never hidden. 882 tests pass.", m + 14), reviewed("completed", m + 3)], checks: [["npm", "test"]], checksResult: [{ code: 0 }] });
  const goals = [newGoal("g1", "Billing: retry failed payments"), newGoal("g2", "Web: runs list stays fresh"), newGoal("g3", "Dashboard smoke test"), newGoal("g4", "Api-gateway rate limits")];
  const tasks = [
    ready("t1", "g1", "Verify ready-review queue", 12), ready("t2", "g1", "Group batch runs by repository", 31), ready("t3", "g1", "Collapse the runs header", 60),
    task("t4", "g1", "Wire the runs badge", "blocked", { round: 2, attempts: [wrote("", 120), reviewed("changes_requested", 110), wrote("", 90), reviewed("changes_requested", 80, { summary: "The nav row still overflows at 280 px.", findings: [{ level: "major", where: "ui.js", issue: "row is cut", fix: "" }] })] }),
    task("t5", "g1", "Refresh runs after a decision", "running", { attempts: [{ id: "x", role: "executor", state: "running", at: ago(6) }] }),
    task("t6", "g2", "Seed the demo flow", "running", { attempts: [{ id: "y", role: "executor", state: "running", at: ago(9) }] }),
    task("t7", "g3", "Account status in the status bar", "accepted"),
  ];
  if (process.env.TWICE) tasks[0].attempts.unshift(wrote("First try", 200), reviewed("changes_requested", 190));
  // The first task ran in its own worktree, so it lists the files it changed and accepting opens its draft PR.
  tasks[0].worktree = { path: "/home/demo/.herdr/worktrees/billing/verify-ready-review-1a2b3c", branch: "run/verify-ready-review-1a2b3c", base: "/home/demo/code/billing",
    baseCommit: "a".repeat(40), reviewedTree: "b".repeat(40) };
  const change = { taskId: "t1", root: "/home/demo/code/billing", fromCommit: "a".repeat(40), toCommit: "b".repeat(40), files: 3, added: 64, removed: 11,
    list: [{ path: "src/runs/queue.js", added: 38, removed: 9 }, { path: "src/runs/queue.test.js", added: 24, removed: 0 }, { path: "src/runs/legend.js", added: 2, removed: 2 }] };
  fake.files[goalsPath()] = JSON.stringify(goals.reduce((doc, g) => saveGoal(doc, g, 0), emptyGoals()));
  fake.files["/home/demo/.config/herdr-app/relevo-workflow/state.json"] = JSON.stringify({ tasks, events: [], engine: { enabled: true } });
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
  if (process.env.RUN) { inbox.openRun(inbox.goalDoc.goals.find((g) => g.id === process.env.RUN), cx); inbox.render(cx); }
  if (process.env.TASK) { inbox.resetRun(process.env.TASK); inbox.render(cx); await flush(); inbox.render(cx); }
  if (process.env.COMPARE) { inbox.openCompare(inbox.workflowTasks.find((x) => x.id === process.env.COMPARE)); inbox.render(cx); }
  if (process.env.PICK) { inbox.runPicked = process.env.PICK.split(","); inbox.render(cx); }
  return { el: inbox.render(cx), width: 400, height: 760 };
}
