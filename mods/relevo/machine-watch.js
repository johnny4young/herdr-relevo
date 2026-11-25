// Why another machine is away, for Spaces and Agents, and the login Herdr waits for once an SSH key would do it.
import { exec, machines, setShared, shared } from "herdr";

export const MACHINES = "relevo.machines";
const RETRY_MS = 120000;

export class MachineWatch {
  constructor() {
    this.tried = {};
  }

  async tick(now = Date.now()) {
    if (!machines().some((m) => m.name && m.layout === "unavailable")) {
      if (Object.keys(shared(MACHINES) ?? {}).length) setShared(MACHINES, {});
      return;
    }
    const r = await exec("hc", ["machine", "ls", "--json"]).catch(() => null);
    let list = [];
    try { list = JSON.parse(r?.stdout ?? "").machines ?? []; } catch { return; }
    const away = {};
    for (const m of list.filter((x) => x.state !== "connected")) {
      away[m.name] = { state: m.state, why: m.why ?? null };
      if (m.state === "needs_login" && !m.via && m.target && now - (this.tried[m.name] ?? 0) > RETRY_MS) {
        this.tried[m.name] = now;
        if (await this.login(m)) away[m.name].state = "connecting";
      }
    }
    if (JSON.stringify(shared(MACHINES) ?? {}) !== JSON.stringify(away)) setShared(MACHINES, away);
  }

  // Only a key that logs in with no one typing is used; `hc machine login` wants a terminal, so `script` gives it one.
  async login(m) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/.test(m.target ?? "") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(m.name ?? "")) return false;
    const key = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", m.target, "true"]).catch(() => null);
    if (key?.code !== 0) return false;
    const done = await exec("script", ["-q", "/dev/null", "hc", "machine", "login", m.name]).catch(() => null);
    return done?.code === 0;
  }
}

