// The Terminals view in the panel: every terminal that is not an agent, by space, and what can be done with each.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, exec, focused, panes, run, settings, setShared, shared, terminals, theme } from "herdr";
import { button, chevron, joined, keyBar, keycap, legHeader, legend, row, tag } from "./ui.js";
import { lastLines, parseListening, parseParents, portsOf, terminalCounts, terminalGroups, terminalRow } from "./lib/terminals.js";
import { ago } from "./lib/time.js";
import { panelShows, showPanel } from "./toolbar.js";

export const TERMINALS_FOCUS = "relevo.terminals.focus";
const TURN = { running: "flight", idle: "open", old: "old", failed: "stuck", done: "ready" };
const READ_EVERY_MS = 10000;

// Herdr has no restart: end it, remove it so its name is free, and start the same command in the same folder.
export async function restartTerminal(r) {
  if (r.live) await exec("hc", ["kill", r.address]);
  await exec("hc", ["rm", r.address]);
  const named = r.name ? ["--name", r.name] : [];
  if (r.background) return exec("hc", ["run", "--bg", ...named, ...(r.cwd ? ["--cwd", r.cwd] : []), "--", ...r.argv]);
  if (r.spaceId) run("space.select", { id: r.spaceId });
  run("terminal.open", { argv: r.argv, folder: r.cwd ?? undefined, place: "tab", ...(r.name ? { name: r.name } : {}) });
}

// A live terminal ends with whatever runs in it; a finished one is removed.
export function endTerminal(r) {
  if (r.live) run("terminal.kill", { terminal: r.address });
  else exec("hc", ["rm", r.address]);
}

export function openTerminal(r) {
  if (r.background) run("terminal.keep", { terminal: r.address, place: "tab" });
  else run("pane.focus", { terminal: r.address });
}

// A request to show Terminals with the keyboard, and the pane Esc gives it back to.
export function focusTerminals() {
  showPanel("terminals");
  setShared(TERMINALS_FOCUS, { at: Date.now(), pane: focused()?.pane ?? null });
}

export class Terminals {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.focusAt = shared(TERMINALS_FOCUS)?.at ?? null;
    this.sel = null;
    this.armed = null;
    this.openDone = false;
    this.help = false;
    this.ports = new Map();
    this.said = new Map();
    this.read(cx);
    cx.timer.every(READ_EVERY_MS, (cx) => this.read(cx));
  }

  // Ports and the selected row's last lines, only while the view is on screen.
  read(cx) {
    if (!panelShows("terminals")) return;
    cx.spawn(async (cx) => {
      const [listening, tree] = await Promise.all([exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]), exec("ps", ["-ax", "-o", "pid=,ppid="])]);
      this.ports = portsOf(this.currentRows(), parseListening(listening?.stdout), parseParents(tree?.stdout));
      const r = this.selected();
      if (r) this.said.set(r.address, lastLines((await exec("hc", ["read", r.address, "--lines", "8"]))?.stdout));
      cx.notify();
    });
  }

  currentRows() {
    const agentSet = new Set(agents().map((a) => a.address)), list = panes(), now = Date.now();
    this.rows = terminals().map((k) => terminalRow(k, { agents: agentSet, panes: list, now })).filter(Boolean);
    return this.rows;
  }

  selected() {
    return (this.rows ?? []).find((r) => r.id === this.sel) ?? null;
  }

  takeFocus(cx) {
    const req = shared(TERMINALS_FOCUS);
    if (!req || req.at === this.focusAt) return;
    this.focusAt = req.at;
    this.returnPane = req.pane;
    cx.timer.after(30, (cx) => {
      this.h.focus();
      cx.notify();
    });
  }

  pick(id, cx) {
    this.sel = this.sel === id ? null : id;
    this.armed = null;
    this.h.focus();
    this.read(cx);
    cx.notify();
  }

  // What a row can do, each with its key: the edge, the selected row's buttons and the keyboard read this one list.
  actions(r) {
    const port = this.ports.get(r.address)?.[0];
    const armed = this.armed === r.address;
    return [
      { id: "open", key: "enter", label: r.background ? "Show" : "Open", run: () => this.open(r), when: r.live || Boolean(r.pane), main: true },
      { id: "peek", key: "p", label: "Peek", run: () => run("terminal.peek", { terminal: r.address }), when: r.live },
      { id: "web", key: "w", label: `Open :${port}`, run: () => exec("open", [`http://localhost:${port}`]), when: Boolean(port) },
      { id: "restart", key: "r", label: "Restart", run: (cx) => cx.spawn(async () => this.restart(r)), when: r.canRestart },
      { id: "stop", key: "s", label: "Stop", run: () => exec("hc", ["interrupt", r.address]), when: r.canStop },
      { id: "park", key: "b", label: "To background", run: () => run("terminal.park", { terminal: r.address }), when: r.live && !r.background },
      { id: "close", key: "x", label: armed ? "Close it" : "Close", run: (cx) => this.close(r, cx), when: true, kind: armed ? "go" : "outline" },
    ].filter((a) => a.when);
  }

  open(r) {
    openTerminal(r);
  }

  // x arms, x again closes: a live terminal ends with whatever runs in it; a finished one is removed.
  close(r, cx) {
    if (this.armed !== r.address) {
      this.armed = r.address;
      return cx.notify();
    }
    this.armed = null;
    endTerminal(r);
    cx.notify();
  }

  restart(r) {
    return restartTerminal(r);
  }

  closeFinished(rows) {
    for (const r of rows) exec("hc", ["rm", r.address]);
  }

  navKey(e, cx) {
    if (!this.h.is_focused() || e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    const items = this.nav ?? [], at = items.findIndex((r) => r.id === this.sel), key = e.key === "j" ? "down" : e.key === "k" ? "up" : e.key;
    if (key === "down" || key === "up") {
      const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + (key === "down" ? 1 : -1)));
      this.sel = items[next]?.id ?? null;
      this.armed = null;
      this.read(cx);
    } else if (key === "?") {
      this.help = !this.help;
    } else if (key === "escape") {
      if (this.armed) this.armed = null;
      else if (this.help) this.help = false;
      else {
        this.sel = null;
        if (this.returnPane) run("pane.focus", { pane: this.returnPane });
      }
    } else {
      const action = at >= 0 && !e.is_held ? this.actions(items[at]).find((a) => a.key === key) : null;
      if (!action) return;
      if (action.id !== "close") this.armed = null;
      action.run(cx);
    }
    cx.stop_propagation();
    cx.notify();
  }

  rowOf(t, r) {
    const sel = this.sel === r.id, ports = this.ports.get(r.address) ?? [], acts = this.actions(r);
    const reason = r.state === "failed" ? `exited ${r.exit}` : r.state === "done" ? "finished"
      : [r.background ? "no pane" : null, r.state === "running" ? null : r.branch ?? (r.cwd ? r.cwd.split("/").pop() : null), r.background ? r.space : null].filter(Boolean).join(" · ") || null;
    const draw = (a) => h_flex().gap(4).items_center().flex_none().child(keycap(t, a.key)).child(button(t, `${r.id}-${a.id}`, a.label, (cx) => { a.run(cx); cx.notify(); },
      { size: "sm", kind: a.kind ?? (a.main ? "solid" : "outline") }));
    const edge = ports.length ? tag(t, ports.map((p) => `:${p}`).join(" "), t.working)
      : r.background ? button(t, `${r.id}-show`, "Show", () => this.open(r), { size: "sm" })
        : r.state === "failed" && r.canRestart ? button(t, `${r.id}-again`, "Restart", (cx) => cx.spawn(async () => this.restart(r)), { size: "sm" })
          : r.state === "old" ? button(t, `${r.id}-close-old`, "Close", (cx) => this.close(r, cx), { size: "sm" }) : null;
    const said = this.said.get(r.address) ?? [];
    const where = [r.cwd ? r.cwd.replace(/^\/(Users|home)\/[^/]+/, "~") : null, r.branch, r.live ? `started ${ago(r.at / 1000)}` : `finished ${ago(r.at / 1000)}`].filter(Boolean).join(" · ");
    return row(t, r.id, {
      turn: TURN[r.state], title: r.title, reason, age: ago(r.at / 1000, true), action: edge, selected: sel, tip: r.cwd,
      onSelect: (cx) => this.pick(r.id, cx),
      below: sel ? [
        div().id(`${r.id}-where`).truncate().text_size(11).text_color(t.muted).child(where),
        ...said.map((line, i) => div().id(`${r.id}-said-${i}`).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.foreground).child(line)),
        this.armed === r.address ? div().id(`${r.id}-armed`).text_size(11).text_color(t.blocked).child(r.live ? "Press x again to end it and what runs in it." : "Press x again to remove it.") : null,
        h_flex().flex_wrap().gap(5).pt(2).children(acts.map(draw)),
      ].filter(Boolean) : null,
    });
  }

  render(cx) {
    const t = theme();
    this.takeFocus(cx);
    const rows = this.currentRows();
    if (this.sel && !rows.some((r) => r.id === this.sel)) this.sel = null;
    const groups = terminalGroups(rows), counts = terminalCounts(rows);
    this.nav = groups.flatMap((g) => (g.folded && !this.openDone ? [] : g.rows));
    const body = groups.flatMap((g) => {
      if (g.folded) {
        return [h_flex().id("term-done").h(28).pt(6).pl(24).pr(8).gap(8).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.openDone = !this.openDone; cx.notify(); })
          .child(chevron(this.openDone, t.dim, 11)).child(div().text_size(11).text_color(t.muted).child(`${g.rows.length} finished`))
          .child(div().flex_1())
          .child(button(t, "term-close-done", `Close ${g.rows.length}`, (cx) => { this.closeFinished(g.rows); cx.notify(); }, { size: "sm", tip: "Remove every finished terminal" })),
        ...(this.openDone ? joined(t, g.rows.map((r) => this.rowOf(t, r))) : [])];
      }
      return [legHeader(t, `term-${g.id}`, g.label, g.rows.length), ...joined(t, g.rows.map((r) => this.rowOf(t, r)))];
    });
    const keys = this.help
      ? v_flex().id("term-help").px(16).py(8).gap(3).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
        .children([["j k", "move"], ["enter", "open, or show one in the background"], ["p", "peek without leaving"], ["w", "open its port"], ["r", "restart its command"],
          ["s", "stop what runs in the shell"], ["b", "send to the background"], ["x x", "close"], ["esc", "back"]]
          .map(([k, what]) => h_flex().gap(8).items_center().children(k.split(" ").map((c) => keycap(t, c))).child(div().child(what))))
      : keyBar(t, "term-keys", [[["j", "k"], "move"], [["enter"], "open"], [["x"], "close"], [["r"], "restart"], [["esc"], "back"]], [["?"], "keys"]);
    return v_flex().id("terminals").size_full().min_h(0).bg(t.surface ?? t.chrome).text_color(t.foreground)
      .track_focus(this.h).tab_index(0).role("group").accessibility_label("Terminals. Arrow keys select a terminal; Enter opens it.")
      .on_key_down((e, cx) => this.navKey(e, cx))
      .child(h_flex().flex_none().border_b(1).border_color(t.border)
        .child(legend(t, "term-legend", [{ turn: "flight", n: counts.running, label: "Running" }, { turn: "open", n: counts.idle, label: "Idle" }, { turn: "stuck", n: counts.failed, label: "Failed" }])))
      .child(v_flex().id("term-list").flex_1().min_h(0).overflow_y_scrollbar().px(8).pt(4).pb(8).gap(2)
        .children(rows.length ? body : [div().id("term-empty").p(16).text_size(13).text_color(t.muted).child("No terminals besides agents.")]))
      .child(keys);
  }
}
