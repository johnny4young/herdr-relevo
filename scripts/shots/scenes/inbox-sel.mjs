// The Inbox panel as main draws it: a waiting agent, review requests, your PRs and uncommitted work. Demo data only.
const HOME = "/home/demo";
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();

const agent = (address, status, space, tab_name) => ({
  address, status, pane: `p-${address}`, tab: `tb-${address}`, tab_name, space: `sp-${space}`, space_name: space, program: { agent: true }, seq: 1,
});
const pane = (address, space, branch) => ({ pane: `p-${address}`, terminal: address, cwd: `${HOME}/code/${space}`, branch, status: "idle", program: { agent: true } });

const QUESTION = [
  " Which strategy should the rate limiter use?",
  " ❯ 1. Token bucket",
  "      Smooth bursts, refills per client",
  "   2. Sliding window",
  "      Exact counts, more memory",
  "   3. Fixed window",
  "",
].join("\n");

const rollup = (state) => ({ state, contexts: { pageInfo: { hasNextPage: false }, nodes: [] } });
const repository = (name) => ({ nameWithOwner: `acme/${name}`, viewerDefaultMergeMethod: "SQUASH", squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true });
const mine = (name, number, title, ci, over = {}) => ({
  number, title, url: `https://github.com/acme/${name}/pull/${number}`, isDraft: false, createdAt: iso(3000), updatedAt: iso(40), reviewDecision: null,
  headRefName: `feat/${number}`, baseRefName: "main", isCrossRepository: false, headRefOid: "abc", additions: 120, deletions: 14,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", autoMergeRequest: null, repository: repository(name),
  commits: { nodes: [{ commit: { committedDate: iso(60), statusCheckRollup: rollup(ci) } }] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});
const requested = (name, number, title, ci, login, minutes) => ({
  number, title, url: `https://github.com/acme/${name}/pull/${number}`, updatedAt: iso(minutes), headRefName: `feat/${number}`, baseRefName: "main",
  isCrossRepository: false, headRefOid: "def", additions: 48, deletions: 9, author: { login }, repository: repository(name),
  commits: { nodes: [{ commit: { statusCheckRollup: rollup(ci) } }] }, reviewThreads: { nodes: [] },
});

const MINE = [
  mine("web", 318, "ABC-151 Retry failed payments at checkout", "FAILURE", { updatedAt: iso(25) }),
  mine("api-gateway", 142, "ABC-142 Rate limit per client", "PENDING", {
    updatedAt: iso(95), reviewDecision: "CHANGES_REQUESTED",
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: false }, { isResolved: true }] },
  }),
];
const REQUESTED = [requested("billing", 77, "ABC-155 Round invoices per line item", "SUCCESS", "mlopez", 180)];

function answer(cmd, args, options = {}) {
  const line = args.join(" ");
  if (cmd === "git") {
    const at = options.cwd ?? args[args.indexOf("-C") + 1] ?? "";
    if (line.includes("--show-toplevel")) return { stdout: `${at}\n` };
    if (line.includes("remote get-url origin")) return { stdout: `https://github.com/acme/${at.split("/").pop()}.git\n` };
    if (line.includes("--shortstat")) return { stdout: " 4 files changed, 86 insertions(+), 12 deletions(-)\n" };
    return null;
  }
  if (cmd === "hc" && args[0] === "read") {
    if (args[1] === "t1") return { stdout: QUESTION };
    return { stdout: "⏺ Rounding now happens per line item; the totals test passes.\n\n❯ \n" };
  }
  if (cmd === "gh" && args[0] === "api") {
    if (line.includes("review-requested")) return { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] } }, search: { nodes: REQUESTED } } }) };
    return { stdout: JSON.stringify({ data: { viewer: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: MINE } } } }) };
  }
  return null;
}

export default async function scene({ fake, cx, flush, load }) {
  fake.agents = [agent("t1", "blocked", "api-gateway", "ABC-142 rate limit"), agent("t2", "done", "billing", "")];
  fake.panes = [pane("t1", "api-gateway", "feat/ABC-142-rate-limit"), pane("t2", "billing", "fix/ABC-155-invoice-rounding")];
  fake.terminals = fake.agents.map((a) => ({ address: a.address, turn: 3, labels: {}, state: "live", parent: null, cwd: `${HOME}/code/${a.space_name}` }));
  fake.exec = answer;
  const now = Date.now() / 1000;
  localStorage.setItem("since", JSON.stringify({ "t1:blocked": now - 240, "t2:done": now - 1500 }));

  const { Inbox } = await load("mods/relevo/inbox.js");
  const inbox = new Inbox();
  inbox.init({}, cx);
  await flush();
  inbox.sel = process.env.SEL ?? null;
  return { el: inbox.render(cx), width: 380, height: 800 };
}
