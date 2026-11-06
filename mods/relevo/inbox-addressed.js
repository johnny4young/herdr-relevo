// Marking a local card addressed. Mixed into Inbox, so `this` is the Inbox.
import { exec, notify, terminals } from "herdr";
import { ADDRESSED_LABEL, addressedValue, staleAddressed } from "./lib/addressed.js";
import { foldRow } from "./ui.js";

export class LocalAddressed {
  // A label takes a moment to come back from the core; until then `labelling` answers ("" = removed).
  addressedLabel(address) {
    return this.labelling[address] ?? this.terms.get(address)?.labels?.[ADDRESSED_LABEL] ?? "";
  }

  readLabels(all, cx) {
    this.terms = new Map(terminals().map((k) => [k.address, k]));
    for (const [address, value] of Object.entries(this.labelling)) {
      const k = this.terms.get(address);
      if (!k || (k.labels?.[ADDRESSED_LABEL] ?? "") === value) delete this.labelling[address];
    }
    for (const a of all) {
      if (staleAddressed(this.addressedLabel(a.address), a.status, this.terms.get(a.address)?.turn)) this.writeAddressed(a.address, "", cx);
    }
  }

  setLocalAddressed(a, on, cx) {
    const turn = terminals().find((k) => k.address === a.address)?.turn;
    this.writeAddressed(a.address, on ? addressedValue(turn) : "", cx);
    this.publish();
    cx.notify();
    // Another agent in the same repo may take over the card.
    this.scanLocal(cx);
  }

  writeAddressed(address, value, cx) {
    this.labelling[address] = value;
    cx.spawn(async (cx) => {
      const r = await exec("hc", ["label", address, `${ADDRESSED_LABEL}=${value}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) return;
      delete this.labelling[address];
      notify({ title: "Could not update the card", body: r.stderr.trim().split("\n")[0], level: "warning" });
      this.publish();
      cx.notify();
    });
  }

  addressedFold(t, key, done, draw) {
    if (!done.length) return [];
    return [
      foldRow(this, t, `addressed-${key}`, `${key}-done`, `${done.length} addressed`),
      ...(this.expanded[`${key}-done`] ? done.map(draw) : []),
    ];
  }
}
