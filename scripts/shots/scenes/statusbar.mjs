// The status row: Herdr's workspace status stand-in beside Relevo's account status, one account at 98%.
export default async function scene({ fake, theme, load }) {
  const { AccountStatus } = await load("mods/relevo/account-status.js");
  const { ACCOUNTS, CODEX } = await load("mods/relevo/accounts.js");
  const now = Date.now() / 1000, w = (pct, inMin) => ({ pct, resets: now + inMin * 60, pace: 0.5 });
  const view = new AccountStatus();
  const [a, b] = ACCOUNTS;
  view.quota = { [a.key]: { updated: now - 60, h5: w(20, 100), d7: w(10, 3000) }, ...(b ? { [b.key]: { updated: now - 60, h5: w(98, 40), d7: w(60, 3000) } } : {}),
    [CODEX.key]: { updated: now - 60, h5: w(5, 100), d7: w(5, 3000) } };
  view.width = 440;
  return { el: view.render(), width: 440, height: 28 };
}
