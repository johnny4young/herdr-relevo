// The agents sidebar as main draws it, sorted by priority. Demo data only.
const HOME = "/home/demo";
const CLAUDE = { key: "claude", name: "claude", agent: true, icon: "icons/claude.svg", tint: true };
const CODEX = { key: "codex", name: "codex", agent: true, icon: "icons/codex.svg", tint: false };

const agent = (address, status, space, title, over = {}) => ({
  address, status, pane: `p-${address}`, tab: `tb-${address}`, title, space: `sp-${space}`, space_name: space, program: CLAUDE, seq: 1,
  pinned: false, focused: false, cwd: `${HOME}/code/${space}`, ...over,
});

export default async function scene({ fake, cx, flush, load }) {
  const list = [
    agent("a1", "blocked", "api-gateway", "ABC-142 rate limit"),
    agent("a2", "done", "billing", "ABC-155 invoice rounding"),
    agent("a3", "working", "web", "ABC-151 checkout retries", { cwd: `${HOME}/code/web-worktrees/checkout-retries` }),
    agent("a4", "working", "api-gateway", "ABC-160 cache auth lookups", { program: CODEX }),
    agent("a5", "idle", "web", "Update the README", { focused: true }),
    agent("a6", "idle", "billing", "Dependency bumps"),
    agent("a7", "idle", "api-gateway", "Release notes", { pinned: true }),
  ];
  const labels = {
    a1: { "agent.account": "work", "agent.jira": "ABC-142" }, a2: { "agent.account": "personal", "agent.jira": "ABC-155" },
    a3: { "agent.account": "work", "agent.bg": "⏱ 1 shell: npm run test:watch" }, a7: { "herdr.pinned": "true" },
  };
  fake.agents = list;
  fake.terminals = [
    ...list.map((a) => ({ address: a.address, state: "live", labels: labels[a.address] ?? {}, parent: null, turn: 2 })),
    { address: "a3-k1", state: "live", labels: {}, parent: "a3", status: "working", name: "Explore payment retries", program: CLAUDE },
    { address: "a3-k2", state: "live", labels: {}, parent: "a3", status: "idle", name: "Write the tests", program: CLAUDE },
  ];
  fake.panes = list.map((a) => ({ pane: a.pane, terminal: a.address, tab: a.tab, title: a.title, program: a.program, cwd: a.cwd }));
  const spaceNames = [...new Set(list.map((a) => a.space_name))];
  fake.spaces = spaceNames.map((name) => ({
    id: `sp-${name}`, name, active: name === "web", folder: `${HOME}/code/${name}`,
    tabs: list.filter((a) => a.space_name === name).map((a) => ({ id: a.tab, name: a.title, named: true })),
  }));
  fake.focused = { agent: "a5" };
  fake.layout = { id: "root", children: [{ id: "sidebar", size: { px: 268 } }] };
  const now = Date.now();
  Object.assign(fake.stored, {
    "agents.sort": "priority",
    "relevo.reasons": { a1: "Which strategy should the rate limiter use?" },
    "relevo.agentPRs": { a2: { number: 77, url: "https://github.com/acme/billing/pull/77", ci: "SUCCESS", add: 86, del: 12 } },
    "relevo.agentContext": { a6: { model: "claude-opus-5-5", context: 84000, at: now / 1000 - 120, ttl: 300 } },
    "relevo.setup": {
      accounts: { personal: { letter: "P", bg: "#c3e88d", fg: "#1e2030", label: "Personal" }, work: { letter: "W", bg: "#82aaff", fg: "#1e2030", label: "Work" } },
      contexts: [{ key: "personal", account: "personal" }, { key: "work", account: "work" }],
    },
    "relevo.elsewhere": [{ id: "e1", state: "working", project: "notes-app", app: "iTerm", bundle: "com.googlecode.iterm2", at: now / 1000 - 120, doing: "Run the sync tests" }],
    "relevo.desktop": [{ id: "d1", state: "review", project: "web", title: "Landing page copy", at: now / 1000 - 5400, said: "Rewrote the hero and pricing copy. The FAQ still says 14 days; should the trial be 30?" }, { id: "d2", state: "working", project: "billing", title: "Retry failed payments", at: now / 1000 - 300, doing: "editing retry.js" }],
  });
  const minutes = { a1: 4, a2: 26, a3: 12, a4: 2, a5: 95, a6: 190, a7: 1500 };
  localStorage.setItem("changed", JSON.stringify(Object.fromEntries(list.map((a) => [a.address, { s: a.status === "done" ? "idle" : a.status, at: now - minutes[a.address] * 60000 }]))));

  const { default: Agents } = await load("mods/relevo-agents/main.js");
  const mod = new Agents();
  mod.init({}, cx);
  await flush();
  if (process.env.OPEN_DESK) mod.openOutside = process.env.OPEN_DESK;
  return { el: mod.render(cx), width: 268, height: 640 };
}
