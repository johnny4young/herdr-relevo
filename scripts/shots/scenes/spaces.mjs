// The Spaces list as main draws it: repos by folder, the open one with everything alive in it. Demo data only.
const HOME = "/home/demo", DAY = 86400e3;
const CLAUDE = { key: "claude", name: "claude", agent: true };
const CODEX = { key: "codex", name: "codex", agent: true };

const space = (id, name, cwd, over = {}) => ({ id, name, folder: `${HOME}/code/${cwd}`, machine: null, active: false, status: null, tabs: [{ id: `tb-${id}` }], ...over });
const git = (name, over = {}) => ({ name, branch: "main", ahead: 0, behind: 0, changed: 0, top: `${HOME}/code/${name}`, repo: JSON.stringify([null, `${HOME}/code/${name}/.git`]), gitDir: `${HOME}/code/${name}/.git`, linked: false, ...over });

export default async function scene({ fake, cx, load }) {
  const now = Date.now();
  fake.spaces = [
    space("api", "api-gateway", "api-gateway", { active: true, status: "blocked" }),
    space("wt", "fix-cache", "api-gateway-worktrees/fix-cache", { status: "working" }),
    space("bill", "billing", "billing", { status: "working" }),
    space("rel", "relevo", "relevo", { status: "done" }),
    space("pv", "portavoz", "portavoz"),
    space("vt", "vitrine", "vitrine"),
    ...["notes", "dotfiles", "blog", "scripts", "recipes"].map((n) => space(`q-${n}`, n, n)),
  ];
  fake.panes = [];
  fake.agents = [
    { address: "a1", status: "blocked", space: "api", pane: "p1", title: "Claude", program: CLAUDE },
    { address: "a2", status: "working", space: "wt", pane: "p2", title: "Codex", program: CODEX },
  ];
  fake.terminals = [];
  fake.layout = { id: "root", children: [{ id: "sidebar", size: { px: 268 } }] };
  Object.assign(fake.stored, {
    "space-folders": { "": { list: [
      { id: "work", name: "Work", color: "ansi4", path: "~/code", match: "api-gateway, billing, messenger" },
      { id: "personal", name: "Personal", color: "ansi2", path: "~/code", match: "~" },
    ], of: {} } },
    "space.colors": { api: "ansi5", bill: "ansi3", rel: "ansi1", pv: "ansi3", vt: "ansi4" },
    "relevo.reasons": { a1: "asks which limiter to use" },
    "relevo.repoPRs": { "api-gateway": { open: 2, me: 1 }, billing: { open: 1, me: 0 }, relevo: { open: 1, me: 0 }, portavoz: { open: 3, me: 1 } },
    "relevo.alive": {
      terminals: [{ address: "t9", title: "npm run dev", state: "running", live: true, spaceId: "api", ports: [3000], canRestart: false, canStop: true }],
      outside: [
        { pid: 530, title: "vite", cwd: `${HOME}/code/billing`, ports: [5173], app: "iTerm" },
        { pid: 540, title: "astro", cwd: `${HOME}/code/vitrine`, ports: [3001], app: "Ghostty" },
        { pid: 550, title: "node", cwd: `${HOME}/code/messenger`, ports: [4000], app: "Terminal" },
      ],
    },
    "relevo.desktop": [{ id: "d1", state: "working", project: "api-gateway", title: "Rate limits", cwd: `${HOME}/code/api-gateway`, doing: "editing limiter.ts", at: now / 1000 }],
  });
  localStorage.setItem("touched", JSON.stringify(Object.fromEntries(fake.spaces.map((s) => [s.id, s.id.startsWith("q-") ? now - 3 * DAY : now]))));
  localStorage.removeItem("opened");
  localStorage.removeItem("closed");

  const { default: Spaces } = await load("mods/relevo-spaces/main.js");
  const { where } = await load("mods/relevo-spaces/model.js");
  const mod = new Spaces();
  mod.init({}, cx);
  const info = {
    api: git("api-gateway", { branch: "feat/rate-limits", ahead: 2 }),
    wt: git("fix-cache", { branch: "fix/cache-auth", ahead: 1, top: `${HOME}/code/api-gateway-worktrees/fix-cache`, linked: true, repo: JSON.stringify([null, `${HOME}/code/api-gateway/.git`]) }),
    bill: git("billing"), rel: git("relevo", { changed: 3 }), pv: git("portavoz", { branch: "feat/voices", ahead: 14 }), vt: git("vitrine"),
  };
  for (const s of fake.spaces) mod.git[where(s, [])] = info[s.id] ?? git(s.name);
  return { el: mod.render(cx), width: 268, height: 640 };
}
