// Does Relevo still load and talk to this Herdr? Shared by `relevo.mjs smoke` and the mod after an update.
// `run(command, args)` resolves to { code, stdout, stderr }; nothing here writes or sends to a terminal.
export const RELEVO_MODS = ["relevo", "relevo-agents", "relevo-files", "relevo-spaces", "relevo-tabs"];
export const SMOKE_FILE = "relevo-install/smoke.json";

const versionIn = (text) => /\d+\.\d+\.\d+\S*/.exec(text ?? "")?.[0] ?? null;
const firstLine = (r) => `${r.stderr ?? ""}\n${r.stdout ?? ""}`.split("\n").map((l) => l.trim())
  .find((l) => l && !l.startsWith("WARN") && !l.startsWith("check failed")) ?? `exit ${r.code}`;
const safely = (run) => async (...args) => { try { return await run(...args); } catch (e) { return { code: -1, stdout: "", stderr: e.message }; } };
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

export async function versions(run) {
  const call = safely(run);
  const [app, core] = await Promise.all([call("herdr-app", ["--version"]), call("hc", ["--version"])]);
  return { app: app.code === 0 ? versionIn(app.stdout) : null, core: core.code === 0 ? versionIn(core.stdout) : null };
}

// `installed`: the mod folders present under the app's mods/. None installed is a failure, never a pass.
export async function smoke({ run, modsDir, installed }) {
  const call = safely(run), results = [];
  const ok = (text) => results.push({ level: "ok", text }), warn = (text) => results.push({ level: "warn", text });
  const fail = (text) => results.push({ level: "fail", text });
  const found = await versions(run);
  if (!found.app) fail("herdr-app does not answer --version"); else ok(`herdr-app ${found.app}`);
  if (!found.core) fail("hc does not answer --version"); else ok(`hc ${found.core}`);

  if (!installed.length) fail(`no Relevo mod is installed in ${modsDir}`);
  for (const mod of installed) {
    const r = await call("herdr-app", ["check", `${modsDir}/${mod}`]);
    if (r.code === 0) ok(`mod ${mod} loads`); else fail(`mod ${mod} does not load: ${firstLine(r)}`);
  }

  const status = await call("herdr-app", ["status"]);
  const errors = status.code === 0 ? parse(status.stdout)?.errors : null;
  const said = (e) => String(e?.message ?? JSON.stringify(e));
  // Another machine Herdr can't reach is the network, not Relevo: it warns and never fails.
  const names = Array.isArray(errors) && errors.length ? (parse((await call("hc", ["machine", "ls", "--json"])).stdout)?.machines ?? []).map((m) => m.name) : [];
  const remote = (e) => names.some((n) => said(e).startsWith(`layout ${n}:`));
  const own = Array.isArray(errors) ? errors.filter((e) => !remote(e)) : [], away = Array.isArray(errors) ? errors.filter(remote) : [];
  const counted = (list) => `${list.length} ${list.length === 1 ? "error" : "errors"}: ${said(list[0]).slice(0, 160)}`;
  if (status.code !== 0) warn("the window is not open: its errors were not read");
  else if (!Array.isArray(errors)) fail("herdr-app status no longer lists errors");
  else {
    if (own.length) fail(`the window reports ${counted(own)}`);
    else ok("the window reports no errors of its own");
    if (away.length) warn(`another machine can't be reached, ${counted(away)}`);
  }

  const ls = await call("hc", ["ls", "--json"]);
  const list = ls.code === 0 ? parse(ls.stdout)?.terminals : null;
  if (!Array.isArray(list)) fail(`hc ls --json no longer lists terminals: ${firstLine(ls)}`);
  else if (list.some((t) => typeof t?.address !== "string" || typeof t?.state !== "string")) fail("hc ls --json: a terminal lacks address or state");
  else {
    const live = list.find((t) => t.state === "live");
    if (!live) warn("no live terminal: hc get and hc read were not tried");
    else {
      const got = parse((await call("hc", ["get", live.address, "--json"])).stdout);
      const lacks = ["state", "status_ms", "labels"].filter((key) => !(key in (got ?? {})));
      if (!got) fail(`hc get ${live.address} --json is not JSON`);
      else if (lacks.length) fail(`hc get --json lacks ${lacks.join(", ")}`);
      else ok("hc get --json");
      const read = await call("hc", ["read", live.address, "--lines", "0"]);
      if (read.code === 0) ok("hc read"); else fail(`hc read ${live.address} failed: ${firstLine(read)}`);
    }
  }
  return { ...found, results, failed: results.filter((r) => r.level === "fail").length };
}

// The record of the last smoke run; a new version pair is what makes the next one due.
export const smokeRecord = (result, at = Date.now()) => ({ app: result.app, core: result.core, passed: !result.failed, at,
  failures: result.results.filter((r) => r.level === "fail").map((r) => r.text) });
export const smokeDue = (record, now) => Boolean(now?.app && now?.core) && (record?.app !== now.app || record?.core !== now.core);
