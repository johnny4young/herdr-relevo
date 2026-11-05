// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, terminals, panes, focused, home, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

export function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
// Where an agent runs, when its space's name doesn't already say it.
export function folderNote(cwd, space) {
  const inHome = cwd === home() || cwd?.startsWith(`${home()}/`);
  const parts = (inHome ? cwd.slice(home().length) : cwd ?? "").split("/").filter(Boolean);
  if (!parts.length) return inHome ? "~" : null;
  return parts.at(-1) === space ? null : parts.slice(-2).join("/");
}

// The sidebar's folders, by the space-folders mod's rules and colors: a dragged space stays
// where it was put, else the first folder whose rules take where it works.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/(?:home|Users)/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

export function folderOfSpace(s, all, ps) {
  const data = all?.[s?.machine ?? ""];
  if (!s || !data) return null;
  const id = data.of?.[s.machine ? s.id.slice(s.machine.length + 1) : s.id];
  if (id !== undefined) return data.list.find((f) => f.id === id) ?? null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  const path = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
  if (!path) return null;
  return data.list.find((f) => (f.match ?? "").split(",").some((p) => rule(p)?.test(path))) ?? null;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// The Inbox's "addressed" mark: `<ms>:<turn>`, cleared when the agent works or asks again.
const SETTLED = "relevo.addressed";
const DESKTOP_STATUS = { working: "working", blocked: "blocked", review: "done" };
// claude-opus-5-5 -> Opus 5.5, as the Relevo mod's Tokens shows it.
function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/.exec(id ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id ?? "";
}
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Model and context from the agent's transcript (the Relevo mod reads it); while it rests, how long its
// prompt cache lasts, since the next message after that writes the whole context again.
function contextTag(t, a, c, now) {
  const left = a.status === "working" ? null : Math.max(0, c.at + c.ttl - now / 1000);
  const cache = left === null ? "" : left > 0 ? ` · cache ${Math.ceil(left / 60)}m` : " · cache gone";
  return div().id(`ctx-${a.address}`).flex_none().text_color(left !== null && left < 600 ? t.ansi3 : t.dim)
    .tooltip(`${modelName(c.model)} · ${c.context.toLocaleString("en-US")} tokens of context. Its prompt cache lasts ${c.ttl / 60} min after the last message; past that, the next message writes it all again.`)
    .child(`${modelName(c.model)} · ${kTokens(c.context)}${cache}`);
}
const desktopLink = (id) => `claude://code/continue?session=${encodeURIComponent(id)}`;
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Account chip from the Claude hook's labels; "borrowed" when it isn't the repo's account.
// The accounts and contexts come from the Relevo mod's config, through shared "relevo.setup".
const setup = () => shared("relevo.setup") ?? { accounts: {}, contexts: [] };

function repoAccount(cwd) {
  const { contexts } = setup(), parts = (cwd ?? "").split("/");
  const folders = shared("space-folders")?.[""]?.list ?? [];
  const owner = contexts.slice(1).find((c) => {
    const names = folders.find((f) => f.id === c.key)?.match?.split(", ") ?? [];
    return names.some((n) => n && parts.includes(n));
  });
  return (owner ?? contexts[0])?.account ?? null;
}

// Background shells or wakeups the Claude hook reports (agent.bg); full text in the tooltip.
function backgroundTag(t, a, labels) {
  const bg = labels["agent.bg"];
  if (!bg) return null;
  const glyph = [...bg][0], n = /\d+/.exec(bg)?.[0] ?? "";
  return div().id(`bg-${a.address}`).flex_none().text_size(11).text_color(t.working)
    .tooltip(`Running in the background: ${bg.slice(glyph.length).trim()}. You'll be told when it finishes.`)
    .child(`${glyph}${n}`);
}

// A letter inside a 14px chip, not text to read.
const CHIP_LETTER = 9;

function accountTag(t, a, labels, pane) {
  const accounts = setup().accounts, acc = accounts[labels["agent.account"]], jira = labels["agent.jira"];
  if (!acc && !jira) return null;
  // A repo's account is a Claude one, so Codex can't be borrowing it.
  const borrowed = acc && labels["agent.account"] !== "codex" && labels["agent.account"] !== repoAccount(pane?.cwd ?? a.cwd);
  const tip = [acc && `${acc.label} account${borrowed ? `, borrowed: this repo uses ${accounts[repoAccount(pane?.cwd ?? a.cwd)]?.label ?? "another"}` : ""}`, jira].filter(Boolean).join(" · ");
  // Local agents only: a handoff reads and starts things on this computer.
  const canMove = Boolean(acc) && !a.address.includes("/");
  return h_flex().id(`acct-${a.address}`).flex_none().gap(4).items_center().tooltip(canMove ? `${tip} · Click to continue with another account` : tip)
    .when(canMove, (el) => el.cursor_pointer().on_click((_e, cx) => {
      cx.stop_propagation();
      run(`relevo.handoff-agent-${a.address}`);
    }))
    .when(Boolean(jira), (el) => el.child(div().text_size(11).text_color(t.dim).child(jira)))
    .when(Boolean(acc), (el) => el.child(div().size(14).rounded(4).bg(acc.bg).text_color(acc.fg).text_size(CHIP_LETTER).font_bold()
      .flex().items_center().justify_center().when(borrowed, (c) => c.border(1.5).border_color(t.ansi3)).child(acc.letter)));
}

const CI = {
  SUCCESS: ["✓", "ansi2", "CI passed"], FAILURE: ["✕", "ansi1", "CI failed"], ERROR: ["✕", "ansi1", "CI failed"],
  PENDING: ["◌", "ansi3", "CI running"], EXPECTED: ["◌", "ansi3", "CI running"], CANCELLED: ["⊘", "ansi3", "CI cancelled"],
};

// The agent's PR: number, CI and size. A click opens it instead of focusing the agent.
function prTag(t, a, pr) {
  const [glyph, color, says] = CI[pr.ci] ?? [];
  return h_flex().id(`pr-${a.address}`).flex_none().gap(4).items_center().cursor_pointer().text_color(t.muted)
    .hover((s) => s.text_color(t.foreground)).tooltip(`${says ? `${says} · ` : ""}Open PR #${pr.number}`)
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (/^https:\/\//.test(pr.url)) exec("open", [pr.url]);
    })
    .child(`#${pr.number}`)
    .when(Boolean(glyph), (el) => el.child(div().font_semibold().text_color(t[color]).child(glyph)))
    .child(div().text_color(t.ansi2).child(`+${pr.add}`))
    .child(div().text_color(t.ansi1).child(`−${pr.del}`));
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    // Settled agents start folded away.
    this.folded = new Set(["settled"]);
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(13)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // Settled: out of the way under its own folded group until the agent works or asks again.
  settleButton(t, a, all, on) {
    return div()
      .id(`settle-${a.address}`)
      .flex_none()
      .px(3)
      .rounded(4)
      .text_size(13)
      .text_color(on ? t.accent : t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(on ? "Back to the list" : "Settle: out of the way until it works or asks again")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const turn = all.find((k) => k.address === a.address)?.turn ?? 0;
        exec("hc", ["label", a.address, `${SETTLED}=${on ? "" : `${Date.now()}:${turn}`}`]);
        this.hovered = null;
        cx.notify();
      })
      .child("✓");
  }

  // Claude Desktop's sessions that work, ask or wait for a review, from the Relevo mod; settled ones stay out.
  desktopSessions() {
    const settled = new Set(shared("relevo.desktop.settled") ?? []);
    return (shared("relevo.desktop") ?? []).filter((s) => DESKTOP_STATUS[s.state] && !settled.has(s.id));
  }

  desktopRow(t, s, now) {
    return h_flex()
      .id(`dk-${s.id}`)
      .h(30)
      .px(8)
      .flex_none()
      .gap(9)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(s.needs || s.detail || s.title || "Open in Desktop")
      .on_click(() => exec("open", [desktopLink(s.id)]))
      .child(div().flex_1().min_w(0).truncate().text_color(s.state === "working" ? t.foreground : t.muted)
        .child(s.title && s.title !== s.project ? `${s.project} · ${s.title}` : s.project))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - s.at * 1000)))
      .child(this.status(t, { status: DESKTOP_STATUS[s.state] }, true));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(13)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.migratePins(all);
    const marks = new Map(all.map((k) => [k.address, k.labels?.[SETTLED] ?? ""]));
    const isSettled = (a) => Boolean(marks.get(a.address)) && a.status !== "working" && a.status !== "blocked";
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned && !isSettled(a));
    const settled = list.filter((a) => !a.pinned && isSettled(a));
    list = [...pinned, ...rest, ...settled];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read panes once: every host read copies the whole list into JS.
    const spaceList = spaces(), ps = panes();
    const leads = leadPanes(ps), paneOf = new Map(ps.map((p) => [p.pane, p]));
    const tabLabels = new Map(spaceList.flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    const rowLabels = new Map(list.map(a => [a.address, tabLabels.get(a.tab) ?? (a.title || a.program?.name || "")]));
    const label = (a) => rowLabels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const labels = new Map(all.map((k) => [k.address, k.labels ?? {}]));
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const tag = accountTag(t, a, labels.get(a.address) ?? {}, paneOf.get(a.pane));
      const bg = backgroundTag(t, a, labels.get(a.address) ?? {});
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      const reply = div()
        .id(`reply-${a.address}`)
        .flex_none()
        .px(3)
        .rounded(4)
        .text_size(13)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Send a message or a quick reply")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run(`relevo.quick-reply-${a.address}`);
        })
        .child("↩");
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      const why = a.status === "blocked" ? shared("relevo.reasons")?.[a.address] : null;
      const cwd = paneOf.get(a.pane)?.cwd ?? a.cwd;
      const place = folderOfSpace(spaceList.find((s) => s.id === a.space), shared("space-folders"), ps);
      const folder = folderNote(cwd, a.space_name);
      const pr = shared("relevo.agentPRs")?.[a.address];
      const ctx = shared("relevo.agentContext")?.[a.address];
      const line = h_flex()
        .h(30)
        .flex_none()
        .items_center()
        .gap(9)
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .when(Boolean(place), (el) => el.child(div().id(`in-folder-${a.address}`).flex_none().tooltip(place.name)
            .child(svg("mods/workspace-chrome/folder.svg").size(12).text_color(MARK[place.color] ?? t.dim))))
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(11).text_color(t.dim).child(machine)))
        .when(Boolean(bg), el => el.child(bg))
        .when(Boolean(tag), el => el.child(tag))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(reply)
          .when(a.status === "idle" || a.status === "done", (el) => el.child(this.settleButton(t, a, all, isSettled(a))))
          .child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
      return v_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .flex_none()
        .rounded(8)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(cwd), (el) => el.tooltip(cwd))
        .child(line)
        .when(Boolean(folder || pr || ctx), (el) => el.child(h_flex().h(14).mb(2).pl(pic ? 25 : 0).gap(6).items_center().text_size(11)
          .when(Boolean(pr), (el) => el.child(prTag(t, a, pr)))
          .when(Boolean(ctx), (el) => el.child(contextTag(t, a, ctx, now)))
          .when(Boolean(folder), (el) => el.child(div().id(`folder-${a.address}`).flex_1().min_w(0).truncate().text_color(t.dim).child(folder)))))
        .when(Boolean(why), (el) => el.child(div().id(`why-${a.address}`).h(14).mb(2).pl(pic ? 25 : 0).truncate()
          .text_size(11).text_color(t.muted).child(why)));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    if (settled.length) groups.push({ id: "settled", label: "Settled", status: null, members: settled });
    const desktop = collapsed ? [] : this.desktopSessions();
    const rows = collapsed
      ? list.flatMap(withKids)
      : [
        ...groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]),
        ...(desktop.length ? [header({ id: "desktop", label: "Desktop", status: null, members: desktop }),
          ...(this.folded.has("desktop") ? [] : desktop.map((s) => this.desktopRow(t, s, now)))] : []),
      ];

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "relevo-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !desktop.length && !collapsed, (el) =>
        el.child(div().px(12).text_size(13).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
