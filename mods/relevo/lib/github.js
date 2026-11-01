// The Inbox's GitHub query and what it makes of the answer; pure, so the tests can feed it fixtures.

export const PR_QUERY = `query {
  viewer { login pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
    number title url isDraft updatedAt reviewDecision repository { nameWithOwner }
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
    reviews(last: 10) { nodes { author { login } state submittedAt } }
    reviewThreads(first: 50) { nodes { isResolved } } } } }
  search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 20) { nodes {
    ... on PullRequest { number title url updatedAt author { login } repository { nameWithOwner }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      reviewThreads(first: 50) { nodes { isResolved } } } } }
}`;

export const RECENT = 45 * 86400;
export const seconds = (iso) => Date.parse(iso) / 1000;
export const recent = (pr) => Date.now() / 1000 - seconds(pr.updatedAt) < RECENT;
export const unresolved = (pr) => (pr.reviewThreads?.nodes ?? []).filter((n) => !n.isResolved).length;

const newest = (x, y) => seconds(y.updatedAt) - seconds(x.updatedAt);

// Your open PRs that need something: failing CI, changes requested, new reviews or open threads.
export function mapMine(data) {
  const me = data.viewer.login;
  const list = data.viewer.pullRequests.nodes.filter((p) => !p.isDraft).map((p) => {
    const last = p.commits.nodes[0]?.commit, ci = last?.statusCheckRollup?.state ?? null;
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
    if (p.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
    if (reviewers.length) reasons.push(`review from ${reviewers.join(", ")}`);
    if (p.reviewDecision === "CHANGES_REQUESTED" || reviewers.length || threads) skills.push("comments");
    return { ...p, repo: p.repository.nameWithOwner, reasons, skills, threads, hot: skills.includes("fix") };
  }).filter((p) => p.reasons.length || p.threads);
  return list.sort(newest);
}

export function mapRequested(data) {
  const list = data.search.nodes.filter((p) => p.url).map((p) => ({
    ...p, repo: p.repository.nameWithOwner, skills: ["review"], threads: unresolved(p),
  }));
  return list.sort(newest);
}
