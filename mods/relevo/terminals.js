// What can be done with a terminal that is not an agent, for Spaces and Maintenance: open, restart, stop, close.
import { agents, exec, notify, panes, run, terminals } from "herdr";
import { terminalRow } from "./lib/terminals.js";

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);

// True once the terminal's own shell is in front again, so typed text reaches the shell and nothing else.
async function shellIsBack(address, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const k = terminals().find((x) => x.address === address);
    if (k?.state !== "live") return false;
    if (k.foreground?.pid === k.pid) return true;
    await exec("sleep", ["0.2"]);
  }
  return false;
}

// Herdr has no restart: end it, remove it so its name is free, and start the same command in the same folder.
export async function restartTerminal(r) {
  // A tab's command runs again in its own shell: stopped first if it still runs, typed only once the shell is back.
  if (r.rerun) {
    if (r.state === "running") await exec("hc", ["interrupt", r.address]);
    if (!(await shellIsBack(r.address))) {
      return notify({ title: `${r.title} did not stop`, body: "Its shell is not back in front, so nothing was typed.", level: "warning" });
    }
    return exec("hc", ["send", r.address, r.rerun.map(quote).join(" ")]);
  }
  if (r.live) await exec("hc", ["kill", r.address]);
  await exec("hc", ["rm", r.address]);
  const named = r.name ? ["--name", r.name] : [];
  if (r.background) return exec("hc", ["run", "--bg", ...named, ...(r.cwd ? ["--cwd", r.cwd] : []), "--", ...r.argv]);
  if (r.spaceId) run("space.select", { id: r.spaceId });
  run("terminal.open", { argv: r.argv, folder: r.cwd ?? undefined, place: "tab", ...(r.name ? { name: r.name } : {}) });
}

// A live terminal ends with whatever runs in it; a finished one is removed. Says so when it is still there.
export async function endTerminal(r, tries = 15) {
  if (r.live) run("terminal.kill", { terminal: r.address });
  else await exec("hc", ["rm", r.address]).catch(() => null);
  for (let i = 0; i < tries; i++) {
    const k = terminals().find((x) => x.address === r.address);
    if (!k || (r.live && k.state !== "live")) return true;
    await exec("sleep", ["0.2"]);
  }
  notify({ title: `${r.title} did not close`, body: r.machine ? `Herdr could not reach ${r.machine}.` : "Herdr did not end it.", level: "warning" });
  return false;
}

export function openTerminal(r) {
  if (r.background) run("terminal.keep", { terminal: r.address, place: "tab" });
  else run("pane.focus", { terminal: r.address });
}

// "relevo.term-<action>-<address>" from the Spaces list, on the terminal as it is now.
export function terminalAction(action, address) {
  const k = terminals().find((x) => x.address === address);
  const r = k && terminalRow(k, { agents: new Set(agents().map((a) => a.address)), panes: panes() });
  if (!r) return null;
  if (action === "open") return openTerminal(r);
  if (action === "peek") return run("terminal.peek", { terminal: r.address });
  if (action === "restart" && r.canRestart) return restartTerminal(r);
  if (action === "stop" && r.canStop) return exec("hc", ["interrupt", r.address]);
  if (action === "close") return endTerminal(r);
  return null;
}
