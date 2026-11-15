// The account usage popup with demo readings: one fine, one about to fill, one stale, Codex weekly-tight.
export default async function scene({ fake, load }) {
  const { AccountStatus } = await load("mods/relevo/account-status.js");
  const { ACCOUNTS, CODEX } = await load("mods/relevo/accounts.js");
  const now = Date.now() / 1000, w = (pct, inMin, pace) => ({ pct, resets: now + inMin * 60, pace });
  const view = new AccountStatus();
  view.detail = true;
  const [a, b] = ACCOUNTS;
  view.quota = {
    [a.key]: { updated: now - 120, h5: w(12, 160, 0.47), d7: w(6, 5 * 1440, 0.3) },
    ...(b ? { [b.key]: { updated: now - 120, h5: w(97, 40, 0.86), d7: w(58, 2 * 1440, 0.7) } } : {}),
    [CODEX.key]: { updated: now - 2520, h5: w(12, 200, 0.3), d7: { pct: 64, resets: now + 6 * 86400, pace: 0.5, span: 30 * 86400 } },
  };
  fake.props = { overlay: "account-popup" };
  return { el: view.render(), width: 420, height: 480 };
}
