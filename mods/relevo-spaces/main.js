// Spaces by folder, one row per repo: its branch when unusual, ahead/behind, files changed, and its most urgent agent.
// Worktrees sit under their checkout. The list order is the spaces' order, so ⌃1…⌃9 pick what is shown.
// Built from Herdr's own spaces mod; folders read the file the space-folders mod kept.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, exec, home, spaces, terminals, panes, run, openOverlay, closeOverlay, props, theme, shared, setShared, watchFolder, window, layout, pickFolder } from "herdr";
import { COLORS, folderData, folderFor, loadFolders, newSpace, openSpaceIn, paint, updateFolders } from "./folders.js";
import { readGit } from "./git.js";
import { aliveBySpace, branchNote, buildModel, movesTo, mostUrgent, portsIn, quietSpaces, spaceTurn, where } from "./model.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// The sidebar's rail goes by its width: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const ICON = (name) => `mods/relevo/icons/${name}.svg`;
const CHROME = (name) => `mods/workspace-chrome/${name}.svg`;
// Changes made outside Herdr (an editor's save, a commit elsewhere): looked for this often while the window is in front.
const FALLBACK_MS = 60000;
// A space quiet for over a day is looked at less often, and the fallback takes a few places per tick so every repo's
// git doesn't run at the same moment; at most this many places are read at once.
const QUIET_FALLBACK_MS = 300000, FALLBACK_PER_TICK = 2, AT_ONCE = 4;
const RAIL_CELL = 32, WATCH_GAP_MS = 1000;
// How long "close N" waits for its confirming second click.
const ARM_MS = 4000;
// The Relevo mod's lane glyphs: a mod can't import from another mod's folder.
export function laneGlyph(t, turn) {
  if (turn === "flight") return svg("mods/relevo/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (turn === "ready") return svg(ICON("check")).size(13).flex_none().text_color(t.done);
  return div().size(8).flex_none().rounded_full().bg(t.blocked);
}
// Folders the Relevo mod keeps in step with its contexts: their rules are its repo lists.
const REPO_PRS = "relevo.repoPRs";
const managed = () => new Set((shared("relevo.setup")?.contexts ?? []).map((c) => c.key));
// Claude Desktop and other terminals' sessions keep their repo from going quiet; Agents lists them, not Spaces.
const sessions = (key) => (shared(key) ?? []).filter((s) => ["working", "blocked", "review"].includes(s.state));
// Spaces shows terminals and servers; agents and their sessions belong to Agents.
const shows = (life) => life.terminals.length + life.servers.length > 0;
const portTag = (t, port, key) => div().id(key).h(16).px(5).flex().flex_none().items_center().rounded(4).bg(`${t.working}26`)
  .text_size(11).text_color(t.working).cursor_pointer().hover((s) => s.bg(`${t.working}40`)).tooltip(`Open http://localhost:${port}`)
  .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [`http://localhost:${port}`]); })
  .child(`:${port}`);
// A plain shell says nothing; what runs, what failed and what ended each have a mark.
function termGlyph(t, r) {
  if (r.state === "failed") return svg(ICON("warn")).size(12).flex_none().text_color(t.blocked);
  if (r.state === "running" && !r.ended) return div().size(6).flex_none().rounded_full().bg(t.working);
  return div().size(6).flex_none().rounded_full().border_1().border_color(t.dim);
}

// A stored value that no longer parses starts over instead of breaking the sidebar.
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export default class Spaces extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.folderMenu) return;
    if (p.editFolder !== undefined) return this.initEditor(p.editFolder, cx);
    this.git = {}; // where() -> git info, null: not a repo
    this.checked = {};
    this.unsure = new Set();
    // where() keys whose folder is gone: no stale branch, and the row says so.
    this.gone = new Set();
    this.pending = new Set();
    this.busy = {};
    this.at = {};
    // git folder -> its pending watch
    this.watching = new Map();
    // Spaces made while this runs wait a moment for their git, so a worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    // The space you are in opens by itself; any other opens or closes with a click on its chevron.
    this.closed = new Set(stored("closed", []));
    this.hovered = null;
    this.armed = null;
    this.touched = stored("touched", {});
    cx.spawn(async (cx) => { await loadFolders(); cx.notify(); });
    cx.timer.every(500, (cx) => this.tick(cx));
  }

  tick(cx) {
    const now = Date.now(), sp = spaces(), ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones, where a command or an agent's turn just ended, and the fallback.
  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    // A place no space is in any more (a closed space, a terminal that moved on) is forgotten, so the list stays the spaces'.
    if (sp.length) for (const k of Object.keys(this.git)) if (!keys.has(k)) { delete this.git[k]; delete this.checked[k]; this.unsure.delete(k); }
    const ids = new Set(sp.map((s) => s.id));
    if (sp.length) for (const id of Object.keys(this.born)) if (!ids.has(id)) delete this.born[id];
    if (sp.length) for (const id of this.shown) if (!ids.has(id)) this.shown.delete(id);
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    if (window().active) {
      const quietAt = new Set(sp.filter((s) => this.quiet?.has(s.id)).map((s) => at[s.id]));
      const late = [...keys].filter((k) => (this.git[k] || this.unsure.has(k)) && !due.has(k)
        && now - (this.checked[k] ?? 0) > (quietAt.has(k) ? QUIET_FALLBACK_MS : FALLBACK_MS));
      late.sort((a, b) => (this.checked[a] ?? 0) - (this.checked[b] ?? 0)).slice(0, FALLBACK_PER_TICK).forEach((k) => due.add(k));
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const batch = [...this.pending].slice(0, AT_ONCE);
        batch.forEach((key) => this.pending.delete(key));
        await Promise.all(batch.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter((g) => g && !JSON.parse(g.repo)[0]).map((g) => g.gitDir));
      for (const dir of [...this.watching.keys()]) if (!used.has(dir)) this.unwatch(dir);
      this.refreshing = false;
      cx.notify();
    });
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      const g = await readGit(cwd, on);
      this.git[key] = g;
      this.gone.delete(key);
      if (g && !on) this.watch(g.gitDir, cx);
    } catch {
      // Couldn't ask (a machine away, a busy disk): keep what it showed and look again later, unless the folder is gone.
      const there = cwd ? await exec("test", ["-d", cwd], { on }).then((r) => r.code === 0, () => null) : null;
      if (there === false) { this.git[key] = null; this.gone.add(key); } else this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  // A commit, checkout or fetch in a local repo changes its git folder. Herdr holds 64 watches for every mod together,
  // so a repo no space shows gives its watch back.
  watch(dir, cx) {
    if (this.watching.has(dir)) return;
    this.watching.set(dir, null);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(dir)) {
          const pending = watchFolder(dir), started = Date.now();
          this.watching.set(dir, pending);
          await pending;
          // A watch that ends at once (its folder gone, or taken back) waits before the next.
          if (Date.now() - started < WATCH_GAP_MS) await cx.sleep(WATCH_GAP_MS);
          if (this.watching.has(dir)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.gitDir === dir), cx);
        }
      } catch { this.watching.delete(dir); }
    });
  }

  unwatch(dir) {
    this.watching.get(dir)?.cancel?.();
    this.watching.delete(dir);
  }

  orderingDue(now) {
    return Boolean(this.ordering) && now - this.ordering.at >= 1000;
  }

  // The model, and the spaces moved to match it. A move can lose a sync race: give the echo a second before retrying.
  model() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const base = buildModel({ spaces: sp, panes: ps, git: this.git, folders: folderData() });
    const life = aliveBySpace(base.groups.flatMap((g) => g.rows), {
      agents: agents(), desktop: sessions("relevo.desktop"), elsewhere: sessions("relevo.elsewhere"), alive: shared("relevo.alive"), home: home(),
    });
    const { quiet, changed } = quietSpaces(base.groups.flatMap((g) => g.rows), life.by, {
      touched: this.touched, prs: shared(REPO_PRS) ?? {}, firstSeen: (id) => this.firstSeen(id),
    });
    // A closed space's mark goes with it.
    if (sp.length) for (const id of Object.keys(this.touched)) if (!sp.some((w) => w.id === id)) { delete this.touched[id]; changed.push(id); }
    if (changed.length) localStorage.setItem("touched", JSON.stringify(this.touched));
    this.quiet = quiet;
    const m = buildModel({ spaces: sp, panes: ps, git: this.git, folders: folderData(), quiet });
    m.life = life;
    const current = sp.map((w) => w.id), key = JSON.stringify([current, m.order]);
    if (current.every((id, i) => id === m.order[i])) this.ordering = null;
    else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      this.ordering = { key, at: Date.now() };
      for (const move of movesTo(current, m.order)) run("space.move", move);
    }
    for (const g of m.groups) g.rows = g.rows.filter((r) => this.shown.has(r.w.id));
    return m;
  }

  // Dropped on a space: it moves there, joining that space's folder. Dropped on a folder: it goes in, last.
  drop(target, m) {
    const from = this.pressed, sp = spaces();
    const moving = sp.find((s) => s.id === from);
    if (!moving || moving.machine) return;
    const group = m.groups.find((g) => (target.folder ? g.id === target.folder : g.rows.some((r) => r.w.id === target.space)));
    if (!group || group.id.startsWith("machine:")) return;
    const fromGroup = m.groups.find((g) => g.rows.some((r) => r.w.id === from));
    if (fromGroup?.id !== group.id) updateFolders((d) => ({ ...d, of: { ...d.of, [from]: group.id === "none" ? undefined : group.id } }));
    const anchor = target.space ?? group.rows.at(-1)?.w.id;
    const index = sp.findIndex((s) => s.id === anchor);
    if (anchor && anchor !== from && index !== -1) run("space.move", { id: from, index: index + 1 });
  }

  toggleFolder(id) {
    updateFolders((d) => ({ ...d, list: d.list.map((f) => (f.id === id ? { ...f, folded: !f.folded } : f)) }));
  }

  dragHandlers(el, target, m) {
    return el
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        const over = JSON.stringify(target);
        if (this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const over = this.over;
        if (this.pressed !== null && over === JSON.stringify(target) && target.space !== this.pressed) this.drop(target, m);
        else if (this.pressed !== null && target.space === this.pressed) run("space.select", { id: this.pressed });
        this.pressed = null;
        this.over = null;
        cx.notify();
      });
  }

  folderHeader(t, g, m, ghosts = 0) {
    const f = g.folder, open = this.groupOpen(g);
    const top = mostUrgent(g.rows.map((r) => r.w.status));
    const target = { folder: g.id };
    const hot = this.pressed !== null && this.over === JSON.stringify(target);
    return this.dragHandlers(h_flex().id(`folder-${g.id}`).h(26).mt(6).px(8).gap(7).flex_none().items_center().rounded(6)
      .when(hot, (el) => el.bg(t.hover))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.pressed !== null) return;
        if (f) this.toggleFolder(f.id);
        else if (g.id.startsWith("machine:")) this.toggle(g.id);
        else return;
        cx.notify();
      })
      .when(Boolean(f), (el) => el.on_mouse_down("right", () => openOverlay({ mod: "relevo-spaces", kind: "popup", width: 200, height: 160, props: { folderMenu: f.id } })))
      .child(svg(ICON(`chevron-${open ? "down" : "right"}`)).size(10).flex_none().text_color(t.dim))
      .child(svg(ICON("folder")).size(12).flex_none().text_color(paint(f?.color, t.dim)))
      .child(div().min_w(0).truncate().text_size(11).font_medium().text_color(t.muted).child((g.label ?? "No folder").toUpperCase()))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(g.rows.filter((r) => !r.tree).length + ghosts)))
      .child(div().flex_1())
      .when(!open && Boolean(spaceTurn(top)), (el) => el.child(laneGlyph(t, spaceTurn(top))))
      .when(Boolean(f?.path), (el) => el.child(div().id(`folder-new-${g.id}`).flex_none().px(4).rounded(4).text_size(13).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`New space in ${f.path}`)
        .on_click((_e, cx) => { cx.stop_propagation(); openSpaceIn(f.path); })
        .child("+"))), target, m);
  }

  // A machine's group has no folder to keep it folded, so it folds like a space's row.
  groupOpen(g) {
    return g.folder ? !g.folder.folded : !g.id.startsWith("machine:") || this.isOpen(g.id);
  }

  // Everything starts open; what you close stays closed.
  isOpen(id) {
    return !this.closed.has(id);
  }

  toggle(id) {
    this.closed.has(id) ? this.closed.delete(id) : this.closed.add(id);
    localStorage.setItem("closed", JSON.stringify([...this.closed]));
  }

  chevron(t, id, open) {
    return div().id(`open-${id}`).size(16).flex().flex_none().items_center().justify_center().rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(open ? "Hide what runs here" : "Show what runs here")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(id); cx.notify(); })
      .child(svg(ICON(`chevron-${open ? "down" : "right"}`)).size(10));
  }

  // The repo's open PRs in Reviews, red when one needs you; a click opens Reviews showing only them.
  prChip(t, id, repo, prs) {
    const tone = prs.me > 0 ? t.blocked : t.dim;
    return h_flex().id(`prs-${id}`).flex_none().gap(3).items_center().px(2).rounded(4).cursor_pointer().text_color(tone)
      .hover((s) => s.bg(t.hover)).tooltip(`${prs.open} open PR${prs.open === 1 ? "" : "s"}${prs.me ? `, ${prs.me} need${prs.me === 1 ? "s" : ""} you` : ""} · Show in Reviews`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run(`relevo.reviews-for-${repo}`); })
      .child(svg(ICON("pr")).size(11).flex_none())
      .child(div().child(String(prs.open)));
  }

  // One line under a space: a mark, a name, what it does, and its ports or where it runs.
  child(t, key, { glyph, title, what = null, hot = false, edge = [], onClick = null, actions = [], deep = false, tip = null }) {
    const hovered = this.hovered === key;
    return h_flex().id(key).h(25).ml(deep ? 44 : 28).px(6).gap(7).flex_none().items_center().rounded(6)
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hovered = key; else if (this.hovered === key) { this.hovered = null; this.armed = null; } cx.notify(); })
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(h_flex().w(12).flex_none().justify_center().child(glyph))
      .child(div().flex_shrink(0).max_w(what ? 118 : 200).truncate().text_color(t.foreground).child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(hot ? t.blocked : t.muted).child(what ?? ""))
      .when(hovered, (el) => el.children(actions))
      .children(edge);
  }

  action(t, key, icon, tip, act, danger = false) {
    return div().id(key).size(18).flex().flex_none().items_center().justify_center().rounded(4)
      .text_color(danger ? t.blocked : t.dim).hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); cx.notify(); })
      .child(svg(icon.includes("/") ? icon : ICON(icon)).size(11));
  }

  // What runs in a space: its terminals and servers.
  lifeRows(t, id, life, deep = false) {
    const rows = [];
    for (const r of life.terminals) {
      const key = `tm-${id}-${r.address}`, armed = this.armed === r.address;
      rows.push(this.child(t, key, {
        glyph: termGlyph(t, r), title: r.title, deep, tip: r.cwd,
        what: r.state === "failed" ? "failed" : r.ended ? "ended" : r.background ? "in the background" : r.branch && r.title !== r.branch ? r.branch : null,
        hot: r.state === "failed",
        edge: (r.ports ?? []).slice(0, 2).map((p) => portTag(t, p, `${key}-port-${p}`)),
        onClick: () => run(`relevo.term-open-${r.address}`),
        actions: [
          ...(r.canRestart ? [this.action(t, `${key}-restart`, "refresh", r.ended ? "Run again" : "Restart", () => run(`relevo.term-restart-${r.address}`))] : []),
          ...(r.canStop ? [this.action(t, `${key}-stop`, CHROME("square"), "Stop what runs", () => run(`relevo.term-stop-${r.address}`))] : []),
          this.action(t, `${key}-close`, "x", armed ? "Click again to close it" : "Close", () => {
            if (!armed) { this.armed = r.address; return; }
            this.armed = null;
            run(`relevo.term-close-${r.address}`);
          }, armed),
        ],
      }));
    }
    for (const s of life.servers) {
      rows.push(this.child(t, `sv-${id}-${s.pid}`, {
        glyph: div().size(6).flex_none().rounded_full().bg(t.working), title: s.title, deep, tip: s.cwd,
        what: s.app ? `in ${s.app}` : "outside Herdr",
        edge: s.ports.slice(0, 2).map((p) => portTag(t, p, `sv-${id}-${s.pid}-port-${p}`)),
        onClick: () => exec("open", [`http://localhost:${s.ports[0]}`]),
      }));
    }
    return rows;
  }

  // A repo with terminals or servers but no space, and + to give it a space.
  ghost(t, entry) {
    const id = `ghost-${entry.project}`, open = this.isOpen(id);
    const ports = portsIn(entry);
    return [h_flex().id(id).h(30).px(6).gap(8).flex_none().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(entry.cwd ?? entry.project)
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(h_flex().size(18).flex_none().rounded(5).border_1().border_color(t.dim).items_center().justify_center()
        .text_size(11).font_bold().text_color(t.dim).child([...entry.project][0]?.toUpperCase() ?? "?"))
      .child(div().flex_shrink(0).max_w(120).truncate().font_medium().text_color(t.muted).child(entry.project))
      .child(h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11).text_color(t.dim)
        .when(ports.length > 0, (el) => el.child(portTag(t, ports[0], `${id}-port`)))
        .child(div().flex_none().child("no space")))
      .when(Boolean(entry.cwd), (el) => el.child(div().id(`${id}-new`).flex_none().px(4).rounded(4).text_size(13).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`New space in ${entry.cwd}`)
        .on_click((_e, cx) => { cx.stop_propagation(); openSpaceIn(entry.cwd); })
        .child("+"))),
    ...(open ? this.lifeRows(t, id, entry) : [])];
  }

  row(t, r, m, life = null) {
    const { w, g, tree } = r;
    const color = (this.frame?.colors ?? shared("space.colors") ?? {})[w.id] ?? "ansi6";
    const branch = branchNote(g, w.name), turn = spaceTurn(w.status);
    const lively = Boolean(life) && shows(life);
    const open = lively && this.isOpen(w.id), ports = life ? portsIn(life) : [];
    const repo = (g?.name ?? w.name ?? "").toLowerCase(), prs = (this.frame?.prs ?? shared(REPO_PRS) ?? {})[repo] ?? null;
    const target = { space: w.id };
    const hot = this.pressed !== null && this.pressed !== w.id && this.over === JSON.stringify(target);
    const gone = this.gone.has(JSON.stringify([w.machine ?? null, r.path]));
    const tip = [r.path, gone ? "folder moved or deleted" : g?.branch && `on ${g.branch}`].filter(Boolean).join(" · ");
    return this.dragHandlers(h_flex().id(`space-${w.id}`).relative().h(tree ? 26 : 30).px(6).gap(8).flex_none().items_center().rounded(6)
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== JSON.stringify(target), (el) => el.opacity(0.5))
      .when(hot, (el) => el.child(div().absolute().left(0).right(0).top(0).h(2).bg(t.accent)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", () => { this.pressed = w.id; this.over = JSON.stringify(target); })
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } }))
      .when(Boolean(tree), (el) => el.pl(28).child(svg(ICON("tree")).size(11).flex_none().text_color(t.dim)))
      .when(!tree, (el) => el.child(h_flex().size(18).flex_none().rounded(5).bg(paint(color, t.accent)).items_center().justify_center()
        .text_size(11).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
      .child(div().flex_shrink(0).max_w(tree ? 120 : 130).truncate().font_medium().text_color(t.foreground).child(tree && g?.branch ? g.branch : w.name))
      .child(h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11).text_color(t.dim)
        .when(gone, (el) => el.child(div().flex_none().text_color(t.blocked).child("folder gone")))
        .when(Boolean(branch) && !tree, (el) => el.child(div().min_w(0).truncate().child(branch)))
        .when(g?.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
        .when(g?.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)))
        .when(g?.changed > 0, (el) => el.child(div().id(`changed-${w.id}`).flex_none().tooltip(`${g.changed} file${g.changed === 1 ? "" : "s"} changed`).child(`±${g.changed}`)))
        .when(ports.length > 0 && !open, (el) => el.child(portTag(t, ports[0], `ports-${w.id}`)).when(ports.length > 1, (p) => p.child(div().flex_none().child(`+${ports.length - 1}`))))
        .when(Boolean(prs) && !tree, (el) => el.child(this.prChip(t, w.id, repo, prs))))
      .when(Boolean(turn), (el) => el.child(h_flex().w(14).flex_none().justify_center().child(laneGlyph(t, turn))))
      .when(lively, (el) => el.child(this.chevron(t, w.id, open))), target, m);
  }

  compact(t, r, i) {
    const { w } = r, turn = spaceTurn(w.status);
    return h_flex().flex_none().justify_center().child(h_flex().id(`space-${w.id}`).relative().w(RAIL_CELL).h(26).rounded(6).justify_center().items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .when(Boolean(turn), (el) => el.child(div().absolute().right(3).child(laneGlyph(t, turn)))));
  }

  render(cx) {
    const t = theme(), p = props() ?? {};
    if (p.folderMenu) return this.folderMenu(t, p.folderMenu);
    if (p.editFolder !== undefined) return this.editor(t, cx);
    this.keepColors();
    // Every row reads these; once per draw is enough.
    this.frame = { colors: shared("space.colors") ?? {}, prs: shared(REPO_PRS) ?? {} };
    const collapsed = narrow(), m = this.model();
    const count = m.groups.reduce((n, g) => n + g.rows.filter((r) => !r.tree).length, 0);
    let i = 0;
    const body = collapsed
      ? m.groups.flatMap((g) => g.rows.map((r) => this.compact(t, r, i++)))
      : this.wide(t, m);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(8).gap(6).flex_none().items_center().text_size(11).text_color(t.dim)
        .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
        .when(!collapsed, (el) => el.child(div().font_medium().child("Spaces")).child(div().child(String(count))).child(div().flex_1())
          .child(div().id("folder-add").size(24).flex_none().flex().items_center().justify_center().rounded(6)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("New folder")
            .on_click(() => openOverlay({ mod: "relevo-spaces", kind: "dialog", width: 460, props: { editFolder: null } }))
            .child(svg(CHROME("folder-plus")).size(14))))
        .child(div().id("space-new").size(24).flex_none().flex().items_center().justify_center().rounded(6)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("New space")
          .on_click(() => newSpace()).child(svg(CHROME("plus")).size(14))))
      .child(v_flex().id("spaces-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; cx.notify(); })
        // A button let go outside the list never reaches it: leaving the list ends the drag.
        .on_hover((on, cx) => { if (!on && this.pressed !== null) { this.pressed = null; this.over = null; cx.notify(); } })
        .children(body));
  }

  // A space seen for the first time was last busy when its newest terminal started.
  firstSeen(id) {
    const started = terminals().filter((k) => k.labels?.["herdr.space"] === id).map((k) => k.created_ms ?? 0);
    return started.length ? Math.max(...started) : Date.now();
  }

  // Spaces quiet for over a day go last in their folder under one line that folds them; Close N closes them all on a second click. Never on its own.
  quietFold(t, g, m, draw) {
    const rows = g.rows.filter((r) => r.quiet);
    if (!rows.length) return [];
    const id = `quiet-${g.id}`, open = this.isOpen(id), ids = rows.filter((r) => !r.tree).map((r) => r.w.id);
    const armed = this.armed === id && Date.now() - (this.armedAt ?? 0) < ARM_MS && JSON.stringify(this.armedIds) === JSON.stringify(ids);
    return [h_flex().id(id).h(26).px(6).gap(7).flex_none().items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.dim)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(h_flex().w(18).flex_none().justify_center().child(svg(ICON(`chevron-${open ? "down" : "right"}`)).size(10)))
      .child(div().flex_1().min_w(0).truncate().child(`${ids.length} quiet for over a day`))
      .child(div().id(`${id}-close`).flex_none().px(5).h(18).flex().items_center().rounded(4)
        .text_color(armed ? t.blocked : t.dim).hover((s) => s.bg(t.hover).text_color(armed ? t.blocked : t.foreground))
        .tooltip(armed ? `Click again to close ${ids.length} space${ids.length === 1 ? "" : "s"} and their terminals` : "Close these spaces")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (!armed) {
            Object.assign(this, { armed: id, armedAt: Date.now(), armedIds: ids });
            cx.timer.after(ARM_MS + 50, (cx) => cx.notify());
            cx.notify();
            return;
          }
          this.armed = null;
          for (const sid of rows.map((r) => r.w.id)) run("space.close", { id: sid, confirmed: true });
          cx.notify();
        })
        .child(armed ? `Close ${ids.length}?` : `close ${ids.length}`)),
    ...(open ? rows.flatMap(draw) : [])];
  }

  // Folder by folder: each space, what runs in the open ones, then repos with something alive but no space.
  wide(t, m) {
    const { by, loose } = m.life;
    const ghosts = new Map();
    for (const entry of loose.filter(shows)) {
      const gid = folderFor(null, entry.cwd, folderData())?.id ?? "elsewhere";
      ghosts.set(gid, [...(ghosts.get(gid) ?? []), entry]);
    }
    const groups = [...m.groups];
    if (ghosts.has("elsewhere")) groups.push({ id: "elsewhere", folder: null, label: "Elsewhere", rows: [] });
    const draw = (r) => {
      const life = by.get(r.w.id), lively = shows(life);
      const shown = lively && this.isOpen(r.w.id);
      return [this.row(t, r, m, life), ...(shown ? this.lifeRows(t, r.w.id, life, Boolean(r.tree)) : [])];
    };
    return groups.flatMap((g) => {
      const open = this.groupOpen(g), mine = ghosts.get(g.id) ?? [];
      const head = g.folder || groups.length > 1 ? [this.folderHeader(t, g, m, mine.length)] : [];
      if (!open) return head;
      return [
        ...head,
        ...g.rows.filter((r) => !r.quiet).flatMap(draw),
        ...this.quietFold(t, g, m, draw),
        ...mine.flatMap((entry) => this.ghost(t, entry)),
      ];
    });
  }

  // Each space keeps one avatar color, the least used one when it appears, as Herdr's own list does.
  keepColors() {
    const sp = spaces(), ids = new Set(sp.map((s) => s.id)), stored = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  folderMenu(t, id) {
    const f = folderData()?.list.find((x) => x.id === id);
    const close = () => closeOverlay(props().overlay);
    const item = (key, label, act, danger = false) => h_flex().id(key).h(31).px(8).rounded(7).items_center()
      .text_color(danger ? t.blocked : t.foreground).hover((el) => el.bg(t.hover))
      .on_click(() => { act(); close(); }).child(label);
    return v_flex().w_full().p(5).bg(t.popover).text_size(13)
      .when(Boolean(f?.path), (el) => el.child(item("folder-space", "New space here", () => openSpaceIn(f.path))))
      .child(item("folder-edit", "Edit folder…", () => openOverlay({ mod: "relevo-spaces", kind: "dialog", width: 460, props: { editFolder: id } })))
      .when(Boolean(f) && !managed().has(id), (el) => el.child(item("folder-delete", "Delete folder", () => updateFolders((d) => ({
        list: d.list.filter((x) => x.id !== id), of: Object.fromEntries(Object.entries(d.of).filter(([, v]) => v !== id)),
      })), true)));
  }

  initEditor(id, cx) {
    const f = (id && folderData()?.list.find((x) => x.id === id)) ?? {};
    this.editing = id;
    this.color = f.color ?? COLORS[(folderData()?.list.length ?? 0) % COLORS.length];
    this.name = InputState.new({ value: f.name ?? "" });
    this.path = InputState.new({ value: f.path ?? "", placeholder: "~/code/client" });
    this.match = InputState.new({ value: f.match ?? "", placeholder: "client-api, ~/code/client-*" });
    for (const input of [this.name, this.path, this.match]) input.on("submit", () => this.saveFolder());
    cx.spawn(async (cx) => { await loadFolders(); cx.notify(); });
  }

  saveFolder() {
    const name = this.name.value().trim();
    if (!name) return;
    const fields = { name, color: this.color, path: this.path.value().trim() || undefined };
    if (!managed().has(this.editing)) fields.match = this.match.value().trim() || undefined;
    const id = this.editing ?? `f${Date.now().toString(36)}`;
    // A new folder goes before the default one, which takes whatever no other folder does.
    updateFolders((d) => (this.editing
      ? { ...d, list: d.list.map((x) => (x.id === id ? { ...x, ...fields } : x)) }
      : { ...d, list: [...d.list.slice(0, Math.max(0, d.list.length - 1)), { id, folded: false, ...fields }, ...d.list.slice(-1)] }));
    closeOverlay(props().overlay);
  }

  editor(t, cx) {
    const field = (label, input) => v_flex().gap(5)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(h_flex().h(30).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).items_center()
        .child(Input.new(input).w_full().text_size(13).text_color(t.foreground)));
    const button = (key, label, act, primary = false) => div().id(key).h(28).px(12).flex().items_center().rounded(6)
      .when(primary, (el) => el.bg(t.accent).text_color(t.background))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(act).child(label);
    return v_flex().w_full().p(16).gap(12).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().font_medium().child(this.editing ? "Edit folder" : "New folder"))
      .child(field("Name", this.name))
      .child(h_flex().gap(6).items_end()
        .child(div().flex_1().child(field("Start new spaces in", this.path)))
        .child(button("folder-pick", "Choose…", () => cx.spawn(async (cx) => {
          const picked = await pickFolder({ prompt: "Start new spaces in" });
          if (picked) { this.path.set_value(picked); cx.notify(); }
        }))))
      .when(!managed().has(this.editing), (el) => el.child(field("Collect spaces from", this.match)))
      .child(h_flex().gap(8).children(COLORS.map((c) => div().id(`folder-color-${c}`).size(18).rounded_full().bg(paint(c))
        .when(c === this.color, (el) => el.border_2().border_color(t.foreground))
        .cursor_pointer().on_click((_e, cx) => { this.color = c; cx.notify(); }))))
      .child(h_flex().gap(8).justify_end()
        .child(button("folder-cancel", "Cancel", () => closeOverlay(props().overlay)))
        .child(button("folder-save", "Save", () => this.saveFolder(), true)));
  }
}
