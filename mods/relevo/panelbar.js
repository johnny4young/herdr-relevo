import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { theme, exec, run, spaces, panes, focused, props, openOverlay, closeOverlay, readTextFile, settings } from "herdr";

const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html",
};
const MAX_FILES = 20000, SHOWN = 60, CHIPS = 4;

// A mod pane has no folder; a terminal beside it in the same tab speaks for it.
export function focusedCwd() {
  const f = focused(), all = panes(), pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  return pane?.cwd
    ?? f?.cwd
    ?? (pane && all.find((p) => p.tab === pane.tab && p.cwd)?.cwd)
    ?? spaces().find((s) => s.active)?.folder
    ?? null;
}

async function checkouts(cwd) {
  const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  if (!top) return { top: null, list: [] };
  const out = (await exec("git", ["worktree", "list", "--porcelain"], { cwd })).stdout, list = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) list.push({ path: line.slice(9) });
    else if (line.startsWith("branch refs/heads/")) list.at(-1).branch = line.slice(18);
    else if (line === "prunable" || line.startsWith("prunable ")) list.at(-1).missing = true;
  }
  return { top, list: list.filter((c) => !c.missing) };
}

export function openFinder() {
  const root = focusedCwd();
  if (root) {
    openOverlay({
      mod: "relevo", kind: "popup", at: "top", offset: 40, width: 640, height: 0.7, props: { role: "find-file", root },
    });
  }
}

// The worktrees of the focused repo; picking one goes to its space, so Files and Changes follow.
export class PanelBar {
  init(_props, cx) {
    this.cwd = null;
    this.top = null;
    this.list = [];
    cx.timer.every(2000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    // A mod pane (a file or a review) has no folder; keep showing the last repo.
    const cwd = focusedCwd() ?? this.cwd;
    if (cwd === this.cwd || this.loading) return;
    this.cwd = cwd;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        Object.assign(this, cwd ? await checkouts(cwd) : { top: null, list: [] });
      } finally {
        this.loading = false;
      }
      cx.notify();
    });
  }

  go(c) {
    const s = spaces().find((x) => !x.machine && x.folder === c.path);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path });
  }

  render() {
    const t = theme(), more = this.list.length - CHIPS;
    const chip = (c) => {
      const on = this.top === c.path, name = c.branch ?? c.path.split("/").pop();
      return div().id(`wt-chip-${c.path}`).h(22).px(8).flex_none().max_w(120).truncate().flex().items_center().rounded(6)
        .text_size(11.5).cursor_pointer()
        .tooltip(c.path)
        .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(() => this.go(c))
        .child(name);
    };
    return v_flex().id("relevo-panel-bar").size_full().px(4).gap(4).justify_center().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().gap(3).items_center().min_w(0)
        .children(this.list.slice(0, CHIPS).map(chip))
        .when(more > 0, (el) => el.child(
          div().id("wt-more").h(22).px(7).flex_none().flex().items_center().rounded(6).text_size(11.5).text_color(t.dim)
            .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("All worktrees")
            .on_click(() => openOverlay({
              mod: "worktree",
              kind: "dialog",
              width: 560,
              height: 480,
              props: { folder: this.cwd, action: "open", space: spaces().find((s) => s.active)?.id },
            }))
            .child(`+${more}`)))
        .when(!this.list.length, (el) => el.child(
          div().px(8).text_size(11.5).text_color(t.dim)
            .child(this.loading ? "…" : "Not a git repository"))))
      .child(h_flex().id("find-file").h(26).px(8).gap(6).items_center().rounded(6)
        .border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => openFinder())
        .child(div().text_color(t.dim).child("⌕"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child(`Open file in ${this.top?.split("/").pop() ?? "…"}`))
        .child(div().text_size(10.5).text_color(t.dim).child("⌘O")));
  }
}

// Subsequence match; earlier, tighter matches and matches in the file name rank first.
function score(path, q) {
  const p = path.toLowerCase(), base = p.lastIndexOf("/") + 1;
  let at = -1, cost = 0;
  for (const ch of q) {
    const i = p.indexOf(ch, at + 1);
    if (i < 0) return null;
    cost += i - at - 1;
    at = i;
  }
  return cost + (p.indexOf(q[0], base) >= base ? 0 : 50) + path.length / 100;
}

export class FileFinder {
  init(_props, cx) {
    this.files = null;
    this.at = 0;
    this.query = "";
    this.input = InputState.new({ value: "", placeholder: "file name or path" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value().trim().toLowerCase();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", () => this.open(this.shown()[this.at]));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    cx.spawn(async (cx) => {
      const root = props()?.root;
      if (!root) {
        this.files = [];
        return cx.notify();
      }
      const r = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
      this.files = r.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, MAX_FILES) : [];
      cx.notify();
    });
  }

  // Scored once per query: render, the arrow keys and Enter all ask for it.
  shown() {
    if (!this.files) return [];
    if (this.memo?.query === this.query && this.memo.files === this.files) return this.memo.rows;
    const rows = !this.query
      ? this.files.slice(0, SHOWN)
      : this.files.map((f) => [f, score(f, this.query)])
        .filter(([, s]) => s !== null)
        .sort((a, b) => a[1] - b[1])
        .slice(0, SHOWN)
        .map(([f]) => f);
    this.memo = { query: this.query, files: this.files, rows };
    return rows;
  }

  close() {
    this.input.release();
  }

  open(file) {
    if (!file) return;
    const p = props();
    closeOverlay(p.overlay);
    run("pane.split", { direction: "right", mod: "relevo", props: { role: "file-view", root: p.root, file } });
  }

  key(e, cx) {
    const n = this.shown().length;
    if (e.key === "escape") return closeOverlay(props().overlay);
    if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme(), rows = this.shown();
    return v_flex().id("find-file-popup").size_full().p(12).gap(8)
      .bg(t.popover ?? t.surface).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background))
      .child(v_flex().id("find-file-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(this.files === null, (el) => el.child(div().p(8).text_color(t.dim).child("…")))
        .when(this.files !== null && !rows.length, (el) => el.child(div().p(8).text_color(t.dim).child("No matching files")))
        .children(rows.map((f, i) => {
          const cut = f.lastIndexOf("/") + 1;
          return h_flex().id(`ff-${f}`).h(28).px(8).gap(8).flex_none().items_center().rounded(6).cursor_pointer()
            .when(i === this.at, (el) => el.bg(t.selected))
            .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click(() => this.open(f))
            .child(div().flex_none().child(f.slice(cut)))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.slice(0, cut)));
        })));
  }
}

export class FileView {
  init(_props, cx) {
    const { root, file } = props() ?? {};
    this.file = file ?? "";
    if (!file) {
      this.error = "No file";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${file}`);
        if (text === null) this.error = "This file is no longer available";
        else if (text.includes("\0")) this.error = "Binary file · no text preview";
        else {
          const t = theme(), ext = file.includes(".") ? file.split(".").pop() : "txt";
          this.code = EditorState.new({
            language: LANG[ext] ?? ext,
            readonly: true,
            value: text.length > 400000 ? `${text.slice(0, 400000)}\n… (file truncated)` : text,
            font_family: settings().font_family,
            font_size: 12,
            syntax: {
              keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
              type: t.ansi3, number: t.ansi1, constant: t.ansi6,
            },
          });
        }
      } catch {
        this.error = "Cannot preview this file";
      }
      cx.notify();
    });
  }

  close() {
    this.code?.release();
  }

  render() {
    const t = theme();
    return v_flex().id("relevo-file-view").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(30).flex_none().px(12).items_center()
        .border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(this.file))
      .child(this.code
        ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.error ?? "Loading…"));
  }
}
