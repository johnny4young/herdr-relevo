// The Inbox's GitHub query and what it makes of the answer; pure, so the tests can feed it fixtures.

const ROLLUP = "statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage } nodes { ... on CheckRun { name status conclusion startedAt } ... on StatusContext { context state } } } }";

const MINE_FIELDS = `number title url isDraft createdAt updatedAt reviewDecision headRefName baseRefName isCrossRepository headRefOid additions deletions changedFiles mergeable mergeStateStatus
    autoMergeRequest { enabledAt }
    repository { nameWithOwner viewerDefaultMergeMethod squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed }
    commits(last: 1) { nodes { commit { committedDate ${ROLLUP} } } }
    reviews(last: 10) { nodes { author { login } state submittedAt } }
    reviewThreads(first: 50) { nodes { isResolved } }`;

// GitHub gives a query about 10 s and answers a slower one with a 502 or nothing; your PRs cost about 0.2 s
// each, so they come in pages, and the rest in a query of its own.
export const MINE_PAGE = 10;
export const MINE_PAGES = 3;
export const mineQuery = (after = null) => `query {
  viewer { pullRequests(states: OPEN, first: ${MINE_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ""}, orderBy: {field: UPDATED_AT, direction: DESC}) {
    pageInfo { hasNextPage endCursor } nodes { ${MINE_FIELDS} } } }
}`;

const OTHER_FIELDS = `number title url isDraft createdAt updatedAt headRefName baseRefName isCrossRepository headRefOid additions deletions changedFiles author { login __typename } repository { nameWithOwner }
      commits(last: 1) { nodes { commit { committedDate ${ROLLUP} } } }
      reviewThreads(first: 50) { nodes { isResolved } }`;

export const OWNER = /^(@me|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;

// Contributors to the owners' repos rarely ask for a review; bots crowd that search, so it reads more than it keeps.
export const othersQuery = (owners = ["@me"]) => `query {
  viewer { login merged: pullRequests(states: MERGED, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
    url number headRefName isCrossRepository mergedAt repository { nameWithOwner } } } }
  search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 20) { nodes {
    ... on PullRequest { ${OTHER_FIELDS} } } }${owners.length ? `
  contributed: search(query: "is:open is:pr ${owners.map((o) => `user:${o}`).join(" ")} -author:@me archived:false sort:updated-desc", type: ISSUE, first: 50) { nodes {
    ... on PullRequest { ${OTHER_FIELDS}
      reviews(last: 10) { nodes { author { login } state submittedAt } } } } }` : ""}
}`;

// The pages and the rest, in the one shape the mappers read.
export function joinPRs(pages, others) {
  const seen = new Set(), nodes = [];
  for (const page of pages) {
    for (const p of page?.viewer?.pullRequests?.nodes ?? []) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      nodes.push(p);
    }
  }
  return {
    viewer: { login: others?.viewer?.login, merged: others?.viewer?.merged ?? { nodes: [] }, pullRequests: { nodes } },
    search: others?.search ?? { nodes: [] },
    contributed: others?.contributed ?? { nodes: [] },
  };
}

export const RECENT = 45 * 86400;
export const seconds = (iso) => Date.parse(iso) / 1000;
export const recent = (pr) => Date.now() / 1000 - seconds(pr.updatedAt) < RECENT;
export const unresolved = (pr) => (pr.reviewThreads?.nodes ?? []).filter((n) => !n.isResolved).length;

const newest = (x, y) => seconds(y.updatedAt) - seconds(x.updatedAt);

const NOT_RED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "CANCELLED", "PENDING", "EXPECTED"]);

// A rerun leaves the runs it replaced in the rollup; like GitHub's page, keep only the newest run of each name.
// A run not started yet is the newest.
function latestRuns(nodes) {
  const at = (n) => (n.startedAt ? Date.parse(n.startedAt) : Infinity), newestOf = new Map();
  for (const n of nodes) if (n.name) newestOf.set(n.name, Math.max(newestOf.get(n.name) ?? -Infinity, at(n)));
  return nodes.filter((n) => !n.name || at(n) === newestOf.get(n.name));
}

// Each check of the last commit, in GitHub's order: { name, state: ok | bad | run | cancel }.
const CHECK_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]), CHECK_BAD = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
export function checksOf(p) {
  const nodes = latestRuns(p.commits?.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []);
  return nodes.map((n) => {
    const name = n.name ?? n.context ?? "check", end = n.conclusion ?? (n.status && n.status !== "COMPLETED" ? null : n.state);
    const state = CHECK_OK.has(end) ? "ok" : CHECK_BAD.has(end) ? "bad" : end === "CANCELLED" ? "cancel" : "run";
    return { name, state };
  });
}

export const checksCut = (p) => Boolean(p.commits?.nodes[0]?.commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage);

// GitHub rolls a cancelled check up as FAILURE, and counts the runs a rerun replaced. Anything else, or a list cut short, stays red.
export function ciOf(p) {
  const rollup = p.commits?.nodes[0]?.commit?.statusCheckRollup, state = rollup?.state ?? null;
  const nodes = rollup?.contexts?.nodes;
  if (state !== "FAILURE" || !nodes || rollup.contexts.pageInfo?.hasNextPage) return state;
  const latest = latestRuns(nodes), ends = latest.map((n) => n.conclusion ?? n.state).filter(Boolean);
  if (latest.length < nodes.length && ends.length && ends.every((s) => CHECK_OK.has(s))) return "SUCCESS";
  return ends.includes("CANCELLED") && ends.every((s) => NOT_RED.has(s)) ? "CANCELLED" : state;
}

const RETRIED = new Set(["CANCELLED", "FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]);

// The Actions runs behind the cancelled or failed checks of `gh pr checks --json state,link`.
export function cancelledRuns(checks, states = RETRIED) {
  const ids = checks.filter((c) => states.has(c.state)).map((c) => /\/actions\/runs\/(\d+)/.exec(c.link ?? "")?.[1]);
  return [...new Set(ids.filter(Boolean))];
}

// Replying to a thread on your own PR files a review of yours, which is not someone reviewing it.
const reviewedBy = (p, me) => (p.reviews?.nodes ?? []).some((r) => r.state !== "PENDING" && r.author?.login !== me);

// Your open PRs that need something: failing CI, changes requested, new reviews or open threads.
// A PR opened in the last day stays in sight even when it only waits for the merge.
export const NEW_FOR = 86400;

export function mapMine(data, now = Date.now() / 1000) {
  const me = data.viewer.login;
  const list = data.viewer.pullRequests.nodes.filter((p) => !p.isDraft).map((p) => {
    const last = p.commits.nodes[0]?.commit, ci = ciOf(p);
    const threads = unresolved(p);
    const since = last ? seconds(last.committedDate) : 0;
    // A comment-only review with every thread resolved (a bot's "no issues found") asks nothing of you.
    const reviewers = [...new Set(p.reviews.nodes
      .filter((v) => v.author?.login !== me && v.state !== "APPROVED" && v.state !== "PENDING" && seconds(v.submittedAt) > since)
      .filter((v) => v.state !== "COMMENTED" || threads > 0)
      .map((v) => v.author?.login?.replace(/-pull-request-reviewer$/, "").replace(/\[bot\]$/, "") ?? "someone"))];
    const reasons = [], skills = [];
    if (ci === "FAILURE" || ci === "ERROR") {
      reasons.push("CI failing");
      skills.push("fix");
    }
    if (ci === "CANCELLED") reasons.push("CI cancelled");
    if (p.mergeable === "CONFLICTING") {
      reasons.push("merge conflict");
      skills.unshift("conflicts");
    }
    if (p.mergeStateStatus === "BEHIND") reasons.push("behind its base");
    if (p.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
    if (reviewers.length) reasons.push(`review from ${reviewers.join(", ")}`);
    if (p.reviewDecision === "CHANGES_REQUESTED" || reviewers.length || threads) skills.push("comments");
    const fresh = !reasons.length && !threads && now - seconds(p.createdAt) < NEW_FOR;
    if (fresh) reasons.push(ci === "SUCCESS" ? "new, CI passed" : ci === "PENDING" || ci === "EXPECTED" ? "new, CI running" : "new");
    return { ...p, repo: p.repository.nameWithOwner, reasons, skills, threads, fresh, hot: skills.includes("fix"), reviewed: reviewedBy(p, me) };
  }).filter((p) => p.reasons.length || p.threads);
  return list.sort(newest);
}

// Your drafts, to mark ready for review.
export function mapDrafts(data) {
  return data.viewer.pullRequests.nodes.filter((p) => p.isDraft)
    .map((p) => ({ ...p, repo: p.repository.nameWithOwner, reasons: ["draft"], skills: [], threads: unresolved(p), hot: false, reviewed: reviewedBy(p, data.viewer.login) }))
    .sort(newest);
}

// Your open PRs with nothing left but the merge: CI green, no changes asked, no open threads.
export function mapReady(data) {
  return data.viewer.pullRequests.nodes.filter((p) => !p.isDraft && ciOf(p) === "SUCCESS"
    && p.reviewDecision !== "CHANGES_REQUESTED" && !unresolved(p))
    .map((p) => ({
      ...p, repo: p.repository.nameWithOwner, skills: [], threads: 0, hot: false,
      reasons: [p.reviewDecision === "APPROVED" ? "approved, CI passed" : "CI passed"],
    }))
    .sort(newest);
}

// A person's PR on a repo of yours, until you review it; a push after your review brings it back.
export function contributedPRs(data) {
  const me = data.viewer?.login;
  return (data.contributed?.nodes ?? []).filter((p) => {
    if (!p.url || p.isDraft || p.author?.__typename === "Bot") return false;
    const since = seconds(p.commits?.nodes[0]?.commit?.committedDate ?? 0) || 0;
    return !(p.reviews?.nodes ?? []).some((r) => r.author?.login === me && r.state !== "PENDING" && seconds(r.submittedAt) >= since);
  });
}

export function mapRequested(data) {
  const asked = new Set(data.search.nodes.map((p) => p.url));
  const unasked = contributedPRs(data).filter((p) => !asked.has(p.url)).map((p) => ({ ...p, unasked: true }));
  const list = [...data.search.nodes.filter((p) => p.url), ...unasked].map((p) => ({
    ...p, repo: p.repository.nameWithOwner, skills: ["review"], threads: unresolved(p), untrusted: p.isCrossRepository,
  }));
  return list.sort(newest);
}

// Every open PR of yours or asking your review, drafts and quiet ones too: an agent's row shows any of them.
export function openPRs(data) {
  const seen = new Map();
  for (const p of [...data.viewer.pullRequests.nodes, ...data.search.nodes.filter((x) => x.url), ...contributedPRs(data)]) {
    if (!seen.has(p.url)) seen.set(p.url, { ...p, repo: p.repository.nameWithOwner, ci: ciOf(p) });
  }
  return [...seen.values()];
}

// Each agent's PR: the one it was started for, else the one at its commit (a review's branch has its own name),
// else the one for its branch, in its repo.
export function agentPRs(places, started, prs) {
  const row = (p) => ({ number: p.number, url: p.url, ci: p.ci, add: p.additions ?? 0, del: p.deletions ?? 0 });
  const byUrl = new Map(prs.map((p) => [p.url, p]));
  const out = {};
  for (const { address, repo, branch, head } of places) {
    if (!repo) continue;
    const mine = prs.filter((x) => x.repo.toLowerCase() === repo.toLowerCase());
    const p = (head && mine.find((x) => x.headRefOid === head))
      || (branch && mine.find((x) => (x.isCrossRepository ? `pr-${x.number}` : x.headRefName) === branch));
    if (p) out[address] = row(p);
  }
  for (const [url, agent] of Object.entries(started ?? {})) {
    if (byUrl.has(url)) out[agent.address] = row(byUrl.get(url));
  }
  return out;
}

// The merged PR of each of this repo's branches; a fork's branch named like one of yours says nothing about yours.
// gh lists the newest first, so a reused name keeps its last merge.
export function mergedByHead(prs) {
  const out = new Map();
  for (const p of prs.filter((x) => !x.isCrossRepository)) {
    if (!out.has(p.headRefName)) out.set(p.headRefName, { number: p.number ?? null, mergedAt: p.mergedAt ? seconds(p.mergedAt) : null });
  }
  return out;
}

const RED = new Set(["FAILURE", "ERROR"]);

const nameOf = (p) => `${p.repository.nameWithOwner.split("/")[1]} #${p.number}`;

// What changed on your open PRs since the last look; the first look sets the baseline and says nothing.
// Drafts only count for merges: one that left the open list and shows among the merged ones.
export function prChanges(before, data, at = Date.now() / 1000) {
  const now = new Map(), events = [];
  for (const p of data.viewer.pullRequests.nodes) {
    const state = { ci: ciOf(p), threads: unresolved(p), decision: p.reviewDecision ?? null, draft: Boolean(p.isDraft) };
    now.set(p.url, state);
    const was = before?.get(p.url);
    if (!was || state.draft || was.draft) continue;
    const name = nameOf(p), base = { url: p.url, repo: p.repository.nameWithOwner, at };
    if (RED.has(state.ci) && !RED.has(was.ci)) events.push({ ...base, kind: "ci-failed", title: `CI failed · ${name}` });
    if (state.ci === "SUCCESS" && was.ci !== "SUCCESS") events.push({ ...base, kind: "ci-passed", title: `CI passed · ${name}` });
    if (state.threads > was.threads) {
      const n = state.threads - was.threads;
      events.push({ ...base, kind: "threads", title: `${n} new review ${n === 1 ? "thread" : "threads"} · ${name}` });
    }
    if (state.decision !== was.decision && state.decision === "APPROVED") events.push({ ...base, kind: "approved", title: `Approved · ${name}` });
    if (state.decision !== was.decision && state.decision === "CHANGES_REQUESTED") {
      events.push({ ...base, kind: "changes", title: `Changes requested · ${name}` });
    }
  }
  for (const p of data.viewer.merged?.nodes ?? []) {
    if (!before?.has(p.url) || now.has(p.url)) continue;
    events.push({
      url: p.url, repo: p.repository.nameWithOwner, kind: "merged", title: `Merged · ${nameOf(p)}`, at: p.mergedAt ? seconds(p.mergedAt) : at,
      head: p.isCrossRepository ? null : p.headRefName,
    });
  }
  return { state: now, events: before ? events : [] };
}
