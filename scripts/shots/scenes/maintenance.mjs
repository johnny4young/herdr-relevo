// Maintenance with demo worktrees: merged ones, one with ignored files, loose ones. Demo names only.
export default async function scene({ fake, cx, flush, load }) {
  const NOW = Date.now() / 1000, DAY = 86400, OLD = NOW - 30 * DAY;
  const tree = (repo, branch, extra = {}) => ({ main: `/home/demo/code/${repo}`, path: `/home/demo/wt/${repo}-${branch.replace(/\W/g, "-")}`, branch, repo, name: branch, merged: false, open: false, at: OLD, ...extra });
  const merged = (repo, branch, n, extra = {}) => tree(repo, branch, { merged: true, pr: { number: n, mergedAt: NOW - 3 * DAY }, ...extra });
  const clean = { locked: false, files: 0, unpushed: 0, unique: 0, ignored: [] };
  fake.exec = (cmd) => (cmd === "gh" ? { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) } : null);
  const { Inbox } = await load("mods/relevo/inbox.js");
  const inbox = new Inbox();
  inbox.init({}, cx);
  await flush();
  fake.stored["relevo.inbox.view"] = "maintenance";
  const list = [merged("billing", "fix/invoice-rounding", 38), merged("billing", "run/batch-by-repo", 42), merged("web", "fix/runs-list", 139),
    merged("api-gateway", "feat/ask-pane", 212, { ignored: [".env.local", "fixtures/ask-audio/", "results.xcresult"] }),
    tree("dashboard", "wip/zsh"), tree("web", "feat/sql-tabs"), tree("api-gateway", "spike/panel")];
  inbox.worktrees = list;
  const states = { "wip/zsh": { ...clean, files: 3 }, "feat/sql-tabs": { ...clean, unique: 2 }, "spike/panel": clean };
  inbox.treeStates = new Map(list.filter((w) => states[w.branch]).map((w) => [w.path, { at: OLD, state: states[w.branch] }]));
  const kb = [217088, 202752, 202752, 1153434, 6144, 317440, 86016];
  inbox.treeSizes = new Map(list.map((w, i) => [w.path, { at: OLD, kb: kb[i] }]));
  inbox.mine = [{ url: "https://github.com/acme/web/pull/98", repo: "acme/web", number: 98, title: "Old experiment", reasons: ["CI failing"], skills: [], updatedAt: "2026-09-20T00:00:00Z" }];
  inbox.sel = process.env.SEL ?? null;
  return { el: inbox.render(cx), width: 380, height: 760 };
}
