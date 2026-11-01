import { CONTEXTS } from "../config.js";

// A remote URL or "owner/repo": the context whose orgs own it, else the default one.
export const ownerOf = (remoteOrRepo) => /([^/:]+)\/[^/:]+?\/?$/.exec(remoteOrRepo ?? "")?.[1]?.toLowerCase();
export const contextFor = (remoteOrRepo, contexts = CONTEXTS) => {
  const owner = ownerOf(remoteOrRepo);
  return contexts.find((c) => c.orgs?.some((o) => o.toLowerCase() === owner)) ?? contexts[0];
};
