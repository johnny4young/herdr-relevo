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
// Kept per path until the folders' rules change, so a render asks the shared state once per path at most.
let byPath = { sign: null, map: new Map() };
export const contextOfPath = (path) => {
  const sign = (shared("space-folders")?.[""]?.list ?? []).map((f) => `${f.id}:${f.match ?? ""}`).join("|");
  if (sign !== byPath.sign || byPath.map.size > 500) byPath = { sign, map: new Map() };
  if (!byPath.map.has(path)) {
    const parts = (path ?? "").split("/");
    byPath.map.set(path, (CONTEXTS.slice(1).find((c) => parts.some((part) => repoNames(c.key).has(part))) ?? CONTEXTS[0]).key);
  }
  return byPath.map.get(path);
};
export const inFocus = (context) => {
  const now = focus();
  return now === "all" || now === context;
};
