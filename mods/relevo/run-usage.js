// How often each part of Runs is opened, to keep what is used and drop what is not: { key: { n, first, last } }
// in shared state, on this machine only.
import { setShared, shared } from "herdr";

export const RUN_USES = "relevo.runs.uses";

export function noteUse(key) {
  const all = shared(RUN_USES) ?? {}, now = Math.round(Date.now() / 1000), was = all[key];
  setShared(RUN_USES, { ...all, [key]: { n: (was?.n ?? 0) + 1, first: was?.first ?? now, last: now } });
}
