import { appHome, exec, setShared, shared } from "herdr";
import * as config from "./config.js";
import { CLI_FOUND, allAccounts, isOn } from "./accounts.js";
import { FIND_SCRIPT, bins, cliOffers, parseIntegrations, withCli } from "./lib/clis.js";
import { PROVIDERS, providerOf } from "./lib/providers.js";
import { WRITE_SCRIPT, renderConfig } from "./lib/settings.js";
import { shellArgv } from "./lib/session-env.js";
import { joined, keysOf, legHeader } from "./ui.js";

// In the person's login shell, as an agent starts: a CLI installed under home is on that PATH only.
const login = (script, ...args) => {
  const [cmd, ...rest] = shellArgv(script, ...args);
  return exec(cmd, rest);
};

const HOOK_WORDS = { outdated: "Herdr hook outdated", "not installed": "no Herdr hook" };

// Mixed into Inbox, so `this` is the Inbox. Agent CLIs found on the machine that Relevo doesn't use yet, and the ones
// it uses whose Herdr hook needs installing again.
export class CliViews {
  scanClis(cx) {
    cx.spawn(async (cx) => {
      const [found, status] = await Promise.all([
        login(FIND_SCRIPT, ...bins()).then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null),
        login("herdr integration status").then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null),
      ]);
      // A shell that found none at all, not even the CLI Relevo runs on, says nothing about the machine.
      const have = new Set((found ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
      if (have.size) {
        setShared(CLI_FOUND, Object.fromEntries(bins().map((bin) => [bin, have.has(bin)])));
      }
      this.integrations = status === null ? null : parseIntegrations(status);
      cx.notify();
    });
  }

  cliItems() {
    const found = shared(CLI_FOUND);
    if (!found) return [];
    const accounts = allAccounts(), keys = (list) => [...new Set(list.map((a) => providerOf(a).key))];
    return cliOffers({ found, integrations: this.integrations, configured: keys(accounts), on: keys(accounts.filter(isOn)), ignored: config.IGNORED_CLIS ?? [] })
      .map((o) => ({ ...o, id: `cli-${o.provider}`, p: PROVIDERS[o.provider] }));
  }

  // Saving config.js reloads the mod, which reads the new account.
  chooseCli(o, choice, cx) {
    if (this.cliBusy) return;
    this.cliBusy = o.id;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", WRITE_SCRIPT, "sh", `${appHome()}/mods/relevo/config.js`, renderConfig(withCli({ ...config }, o.provider, choice))])
        .catch((e) => ({ code: 1, stderr: String(e) }));
      this.cliBusy = null;
      this.cliError = r.code === 0 ? null : { id: o.id, text: r.stderr?.trim() || "Could not write config.js" };
      cx.notify();
    });
  }

  updateHook(o, cx) {
    if (this.cliBusy) return;
    this.cliBusy = o.id;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await login('herdr integration install "$1"', o.p.integration).catch((e) => ({ code: 1, stderr: String(e) }));
      this.cliBusy = null;
      this.cliError = r.code === 0 ? null : { id: o.id, text: r.stderr?.trim() || `herdr integration install ${o.p.integration} failed` };
      this.scanClis(cx);
      cx.notify();
    });
  }

  cliActions(o) {
    const busy = Boolean(this.cliBusy);
    const hook = o.hook && { id: `${o.id}-hook`, key: "u", label: "Update hook", run: (cx) => this.updateHook(o, cx), disabled: busy,
      tip: `herdr integration install ${o.p.integration}` };
    const ignore = { id: `${o.id}-ignore`, key: "i", label: "Ignore", run: (cx) => this.chooseCli(o, "ignore", cx), disabled: busy, kind: "ghost",
      tip: "Not offered again; Settings lists it" };
    if (o.kind === "hook") return { main: { ...hook, kind: "go" }, actions: [] };
    return {
      main: { id: `${o.id}-on`, key: "a", label: "Activate", run: (cx) => this.chooseCli(o, "activate", cx), disabled: busy, kind: "go",
        tip: `Adds ${o.p.name} to config.js` },
      actions: [hook, ignore].filter(Boolean),
    };
  }

  cliNav() {
    return this.cliItems().map((o) => ({ id: o.id, section: "clis", go: this.cliActions(o).main.run, keys: () => keysOf(this.cliActions(o)) }));
  }

  cliGroup(t) {
    const items = this.cliItems();
    if (!items.length) return [];
    return [legHeader(t, "leg-clis", "Agent CLIs", items.length),
      ...joined(t, items.map((o) => {
        const { main, actions } = this.cliActions(o), error = this.cliError?.id === o.id ? this.cliError.text : null;
        const reason = o.kind === "new" ? [`${o.p.bin} found`, HOOK_WORDS[o.hook]].filter(Boolean).join(" · ") : HOOK_WORDS[o.hook];
        return this.item(t, o.id, {
          turn: "open", kind: "agent", title: o.p.name, reason: this.cliBusy === o.id ? "working…" : error ?? reason, tip: error ?? reason, main, actions,
        });
      }))];
  }
}
