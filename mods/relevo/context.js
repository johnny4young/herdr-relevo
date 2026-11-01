import { shared, setShared } from "herdr";
import { CONTEXTS } from "./config.js";
import { contextFor } from "./lib/context.js";

export { contextFor };

// What the agents sidebar needs to draw account chips, published once per change.
export const SHARED_SETUP = "relevo.setup";
export function publishSetup(accounts) {
  const setup = {
    accounts: Object.fromEntries(accounts.map((a) => [a.key, { letter: a.letter, bg: a.bg, fg: a.fg, label: a.label }])),
    contexts: CONTEXTS.map((c) => ({ key: c.key, account: c.account })),
  };
  if (JSON.stringify(shared(SHARED_SETUP)) !== JSON.stringify(setup)) setShared(SHARED_SETUP, setup);
}
export const accountFor = (remoteOrRepo) => contextFor(remoteOrRepo).account;

// Focus: "all" or a context key. Paths use each context folder's repo list.
export const FOCUS = "relevo.focus";
export const focus = () => shared(FOCUS) ?? "all";
// Called per row on every Inbox render, so each split rule list is kept until it changes.
const names = new Map();
const repoNames = (key) => {
  const match = (shared("space-folders")?.[""]?.list ?? []).find((f) => f.id === key)?.match ?? "";
  if (names.get(key)?.match !== match) names.set(key, { match, set: new Set(match.split(", ").filter(Boolean)) });
  return names.get(key).set;
};
export const contextOfPath = (path) => {
  const parts = (path ?? "").split("/");
  return (CONTEXTS.slice(1).find((c) => parts.some((part) => repoNames(c.key).has(part))) ?? CONTEXTS[0]).key;
};
export const inFocus = (context) => focus() === "all" || focus() === context;
