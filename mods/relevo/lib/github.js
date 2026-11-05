// The Inbox's GitHub query and what it makes of the answer; pure, so the tests can feed it fixtures.

const ROLLUP = "statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage } nodes { ... on CheckRun { conclusion } ... on StatusContext { state } } } }";

export const PR_QUERY = `query {
  viewer { login pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
    number title url isDraft updatedAt reviewDecision headRefName baseRefName isCrossRepository headRefOid additions deletions mergeable mergeStateStatus
    autoMergeRequest { enabledAt }
    repository { nameWithOwner viewerDefaultMergeMethod squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed }
    commits(last: 1) { nodes { commit { committedDate ${ROLLUP} } } }
    reviews(last: 10) { nodes { author { login } state submittedAt } }
    reviewThreads(first: 50) { nodes { isResolved } } } }
    merged: pullRequests(states: MERGED, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
      url number headRefName isCrossRepository repository { nameWithOwner } } } }
  search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 20) { nodes {
    ... on PullRequest { number title url updatedAt headRefName baseRefName isCrossRepository headRefOid additions deletions author { login } repository { nameWithOwner }
      commits(last: 1) { nodes { commit { ${ROLLUP} } } }
      reviewThreads(first: 50) { nodes { isResolved } } } } }
}`;

export const RECENT = 45 * 86400;
export const seconds = (iso) => Date.parse(iso) / 1000;
export const recent = (pr) => Date.now() / 1000 - seconds(pr.updatedAt) < RECENT;
export const unresolved = (pr) => (pr.reviewThreads?.nodes ?? []).filter((n) => !n.isResolved).length;

const newest = (x, y) => seconds(y.updatedAt) - seconds(x.updatedAt);

const NOT_RED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "CANCELLED", "PENDING", "EXPECTED"]);

// GitHub rolls a cancelled check up as FAILURE, but nothing failed. Anything else, or a list cut short, stays red.
export function ciOf(p) {
  const rollup = p.commits?.nodes[0]?.commit?.statusCheckRollup, state = rollup?.state ?? null;
  const nodes = rollup?.contexts?.nodes;
  if (state !== "FAILURE" || !nodes || rollup.contexts.pageInfo?.hasNextPage) return state;
  const ends = nodes.map((n) => n.conclusion ?? n.state).filter(Boolean);
  return ends.includes("CANCELLED") && ends.every((s) => NOT_RED.has(s)) ? "CANCELLED" : state;
}

const RETRIED = new Set(["CANCELLED", "FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]);

// The Actions runs behind the cancelled or failed checks of `gh pr checks --json state,link`.
export function cancelledRuns(checks, states = RETRIED) {
  const ids = checks.filter((c) => states.has(c.state)).map((c) => /\/actions\/runs\/(\d+)/.exec(c.link ?? "")?.[1]);
  return [...new Set(ids.filter(Boolean))];
}

// Your open PRs that need something: failing CI, changes requested, new reviews or open threads.
export function mapMine(data) {
  const me = data.viewer.login;
  const list = data.viewer.pullRequests.nodes.filter((p) => !p.isDraft).map((p) => {
    const last = p.commits.nodes[0]?.commit, ci = ciOf(p);
    const threads = unresolved(p);
    const since = last ? seconds(last.committedDate) : 0;
    const reviewers = [...new Set(p.reviews.nodes
      .filter((v) => v.author?.login !== me && v.state !== "APPROVED" && v.state !== "PENDING" && seconds(v.submittedAt) > since)
      .map((v) => v.author?.login?.replace(/-pull-request-reviewer$/, "").replace(/\[bot\]$/, "") ?? "someone"))];
    const reasons = [], skills = [];
    if (ci === "FAILURE" || ci === "ERROR") {
      reasons.push("CI failing");
      skills.push("fix");
    }
    if (ci === "CANCELLED") reasons.push("CI cancelled");
    if (p.mergeable === "CONFLICTING") reasons.push("merge conflict");
    if (p.mergeStateStatus === "BEHIND") reasons.push("behind its base");
    if (p.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
    if (reviewers.length) reasons.push(`review from ${reviewers.join(", ")}`);
    if (p.reviewDecision === "CHANGES_REQUESTED" || reviewers.length || threads) skills.push("comments");
    return { ...p, repo: p.repository.nameWithOwner, reasons, skills, threads, hot: skills.includes("fix") };
  }).filter((p) => p.reasons.length || p.threads);
  return list.sort(newest);
}

// Your drafts, to mark ready for review.
export function mapDrafts(data) {
  return data.viewer.pullRequests.nodes.filter((p) => p.isDraft)
    .map((p) => ({ ...p, repo: p.repository.nameWithOwner, reasons: ["draft"], skills: [], threads: unresolved(p), hot: false }))
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

export function mapRequested(data) {
  const list = data.search.nodes.filter((p) => p.url).map((p) => ({
    ...p, repo: p.repository.nameWithOwner, skills: ["review"], threads: unresolved(p), untrusted: p.isCrossRepository,
  }));
  return list.sort(newest);
}

// Every open PR of yours or asking your review, drafts and quiet ones too: an agent's row shows any of them.
export function openPRs(data) {
  const seen = new Map();
  for (const p of [...data.viewer.pullRequests.nodes, ...data.search.nodes.filter((x) => x.url)]) {
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

// Branch names of merged PRs from this repo; a fork's branch named like one of yours says nothing about yours.
export const mergedHeads = (prs) => prs.filter((p) => !p.isCrossRepository).map((p) => p.headRefName);

const RED = new Set(["FAILURE", "ERROR"]);

const nameOf = (p) => `${p.repository.nameWithOwner.split("/")[1]} #${p.number}`;

// What changed on your open PRs since the last look; the first look sets the baseline and says nothing.
// Drafts only count for merges: one that left the open list and shows among the merged ones.
export function prChanges(before, data) {
  const now = new Map(), events = [];
  for (const p of data.viewer.pullRequests.nodes) {
    const state = { ci: ciOf(p), threads: unresolved(p), decision: p.reviewDecision ?? null, draft: Boolean(p.isDraft) };
    now.set(p.url, state);
    const was = before?.get(p.url);
    if (!was || state.draft || was.draft) continue;
    const name = nameOf(p), base = { url: p.url, repo: p.repository.nameWithOwner };
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
      url: p.url, repo: p.repository.nameWithOwner, kind: "merged", title: `Merged · ${nameOf(p)}`,
      head: p.isCrossRepository ? null : p.headRefName,
    });
  }
  return { state: now, events: before ? events : [] };
}
