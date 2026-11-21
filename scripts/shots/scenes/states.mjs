// Reviews Now in one of its states: STATE=calm|first|error|away|narrow. Demo data only.
import base from "./inbox-today.mjs";

export default async function scene(ctx) {
  const { fake, cx, flush, load } = ctx, state = process.env.STATE ?? "calm";
  await base(ctx);
  if (state === "calm") {
    // Nothing waits: one agent working, no PRs that need you.
    fake.agents = [{ ...fake.agents[0], status: "working" }];
    const orig = fake.exec;
    const none = { data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } }, search: { nodes: [] } } };
    fake.exec = (cmd, args, o) => (cmd === "gh" && args[0] === "api" ? { stdout: JSON.stringify(none) } : orig(cmd, args, o));
  }
  const { Inbox } = await load("mods/relevo/inbox.js");
  const inbox = new Inbox();
  inbox.init({}, cx);
  await flush();
  const now = Date.now();
  if (state === "first") Object.assign(inbox, { prsAt: null, scanningPRs: true, scanStarted: now, snap: null });
  if (state === "error") Object.assign(inbox, { error: "PRs: gh: HTTP 502 Bad Gateway", prsAt: now - 12 * 60000, snap: null });
  if (state === "away") {
    inbox.digest = { since: now - 95 * 60000, now, finished: ["t2"], waiting: ["t1"], said: { t2: "Rounding per line item; totals test passes" }, seconds: 2700,
      prs: [{ title: "CI failed · web #318", url: "https://github.com/acme/web/pull/318", at: now / 1000 - 25 * 60 },
        { title: "Merged · api #142", url: "https://github.com/acme/api/pull/142", at: now / 1000 - 80 * 60 }], quota: [{ key: "p", label: "Personal", h5: 12, d7: 3 }] };
  }
  if (state === "narrow") Object.assign(inbox, { narrowInbox: true, tightInbox: true });
  inbox.h.is_focused = () => true;
  return { el: inbox.render(cx), width: state === "narrow" ? 280 : 380, height: 760 };
}
