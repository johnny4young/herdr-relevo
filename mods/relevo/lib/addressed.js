// PRs marked addressed: url -> seconds when marked. One stays hidden until GitHub shows activity after that.
export const isAddressed = (pr, marks) => (marks?.[pr.url] ?? 0) >= Date.parse(pr.updatedAt) / 1000;

// Marks only for PRs still listed, so the file doesn't grow.
export const keepListed = (marks, urls) => Object.fromEntries(Object.entries(marks ?? {}).filter(([url]) => urls.has(url)));
