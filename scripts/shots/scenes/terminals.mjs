// The Terminals view with demo terminals: a dev server, a shell, a failed test run, one in the background, an old shell. SEL=t2 opens one.
export default async function scene({ fake, cx, flush, load }) {
  const now = Date.now(), min = 60e3;
  const term = (address, over = {}) => ({ address, state: "live", argv: ["/bin/zsh", "-l"], pid: 100, foreground: { pid: 100, name: "zsh", argv: ["zsh"], cwd: "/home/demo/code/api-gateway" },
    cwd: "/home/demo/code/api-gateway", labels: { where: "api-gateway / 1" }, status: null, created_ms: now - 5 * min, exit_code: null, name: null, parent: null, ...over });
  fake.terminals = [
    term("t1"),
    term("t2", { pid: 200, foreground: { pid: 210, name: "node", argv: ["npm", "run", "dev"], cwd: "/home/demo/code/api-gateway" }, created_ms: now - 12 * min }),
    term("t3", { labels: { where: "billing / 1" }, cwd: "/home/demo/code/billing", pid: 300, foreground: { pid: 310, name: "node", argv: ["vite"], cwd: "/home/demo/code/billing" }, created_ms: now - 64 * min }),
    term("t4", { labels: { where: "billing / 2" }, cwd: "/home/demo/code/billing", state: "finished", argv: ["npm", "test"], exit_code: 1, finished_ms: now - 2 * min }),
    term("t5", { labels: { where: "api-gateway / 3" }, argv: ["go", "run", "."], name: "api-server", pid: 500, foreground: { pid: 500, name: "go", argv: ["go", "run", "."] }, created_ms: now - 190 * min }),
    term("t6", { labels: { where: "notes-app / 1" }, cwd: "/home/demo/code/notes-app", created_ms: now - 2 * 1440 * min }),
    term("t7", { state: "finished", exit_code: 0, finished_ms: now - 30 * min }),
    term("t8", { status: { app: "claude-code", state: "working" } }),
  ];
  fake.panes = [{ pane: "p1", terminal: "t1", branch: "feat/rate-limits" }, { pane: "p2", terminal: "t2", branch: "feat/rate-limits" }, { pane: "p3", terminal: "t3", branch: "chore/invoices" },
    { pane: "p4", terminal: "t4" }, { pane: "p6", terminal: "t6", branch: "main" }, { pane: "p7", terminal: "t7" }];
  fake.layout = { id: "root", children: [{ id: "panel", hidden: false, children: [{ id: "panel-body", active: "terminals", children: [] }] }] };
  fake.exec = (cmd) => (cmd === "lsof" ? { stdout: "p220\nn*:3000\np310\nn*:5173\np500\nn*:8080\n" } : cmd === "ps" ? { stdout: "220 210\n" }
    : cmd === "hc" ? { stdout: "  VITE v6.2.0  ready in 412 ms\n\n  ➜  Local:   http://localhost:3000/\n" } : null);
  const { Terminals } = await load("mods/relevo/terminals.js");
  const view = new Terminals();
  view.init({}, cx);
  view.h.is_focused = () => true;
  await flush();
  view.render(cx);
  if (process.env.SEL) { view.pick(`term-${process.env.SEL}`, cx); await flush(); }
  return { el: view.render(cx), width: 380, height: 720 };
}
