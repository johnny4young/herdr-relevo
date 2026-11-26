// What runs besides agents, for the Spaces list: every terminal with its ports, and servers started in other apps.
import { agents, exec, home, panes, setShared, shared, terminals, window } from "herdr";
import { DYNAMIC_PORT, outsideServers, parseCwds, parseListening, parseProcs, portsOf, terminalRow } from "./lib/terminals.js";

export const ALIVE = "relevo.alive";
const KEEP = ["address", "title", "state", "live", "background", "pane", "branch", "cwd", "spaceId", "canRestart", "canStop", "ended", "at"];
const STUCK_MS = 60000;

export class AliveWatch {
  async read() {
    const agentSet = new Set(agents().map((a) => a.address)), list = panes(), now = Date.now();
    const rows = terminals().map((k) => terminalRow(k, { agents: agentSet, panes: list, now })).filter(Boolean);
    const [listening, ps] = await Promise.all([
      exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).catch(() => null),
      exec("ps", ["-ax", "-o", "pid=,ppid=,comm="]).catch(() => null),
    ]);
    if (!listening || !ps) return null;
    const open = parseListening(listening.stdout), procs = parseProcs(ps.stdout);
    const parents = new Map([...procs].map(([pid, p]) => [pid, p.ppid]));
    const ports = portsOf(rows, open, parents);
    // Every Herdr terminal's process, agents too: a server an agent started is the agent's, not another app's.
    const owned = new Set(terminals().flatMap((k) => [k.pid, k.foreground?.pid]).filter(Boolean));
    const strays = [...new Set(open.filter((l) => l.port < DYNAMIC_PORT).map((l) => l.pid))];
    const cwds = strays.length ? parseCwds((await exec("lsof", ["-a", "-d", "cwd", "-p", strays.join(","), "-Fpn"]).catch(() => null))?.stdout) : new Map();
    return {
      terminals: rows.map((r) => ({ ...Object.fromEntries(KEEP.map((k) => [k, r[k]])), ports: ports.get(r.address) ?? [] })),
      outside: outsideServers(open, procs, owned, cwds, home()),
    };
  }

  // While the window is in front; a background window keeps what it showed.
  async tick() {
    if (!window().active || (this.busy && Date.now() - this.busySince < STUCK_MS)) return;
    const gen = this.tickGen = (this.tickGen ?? 0) + 1;
    this.busy = true;
    this.busySince = Date.now();
    try {
      const now = await this.read();
      if (gen === this.tickGen && now && JSON.stringify(shared(ALIVE) ?? null) !== JSON.stringify(now)) setShared(ALIVE, now);
    } finally {
      if (gen === this.tickGen) this.busy = false;
    }
  }
}
