// A lazy file browser for the focused pane's folder, with file actions and editable previews.
// Derived from the `files` mod that ships with Herdr (Apache-2.0).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, props, shared } from "herdr";
import { FileEditor } from "./editor.js";
import { FileMenu, NameDialog, openMenu } from "./actions.js";
import { FileView } from "./view.js";
import { moved, isUnder, parentOf } from "./lib/paths.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

export async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export class Files {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key && this.editor?.dirty) return;
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.editor?.close(); this.editor = null; this.file = path; this.leaving = false;
    if (!path || !cx) return;
    const on = this.on;
    this.editor = new FileEditor(`${this.root}/${path}`, !on);
    this.editor.load(cx, p => readTextFile(p, { on }));
  }

  back(cx) {
    if (this.editor?.dirty) this.leaving = true;
    else this.show(null);
    cx.notify();
  }

  // What the menu and name dialog did, from shared "relevo-files.event".
  follow(cx) {
    const e = shared("relevo-files.event");
    if (!e || e.n === this.seen) return;
    const first = this.seen === undefined;
    this.seen = e.n;
    if (first || e.root !== this.root) return;
    if (e.kind === "moved") {
      if (this.file && isUnder(this.file, e.path)) {
        this.file = moved(this.file, e.path, e.to);
        if (this.editor) this.editor.path = `${this.root}/${this.file}`;
      }
      this.folders = new Set([...this.folders].map(f => moved(f, e.path, e.to)));
    } else if (e.kind === "trashed") {
      // Unsaved edits stay; the editor offers Keep mine, as for any file deleted on disk.
      if (this.file && isUnder(this.file, e.path)) {
        if (this.editor?.dirty) this.editor.disk = null;
        else this.show(null);
      }
      for (const f of [...this.folders]) if (isUnder(f, e.path)) this.folders.delete(f);
    } else {
      for (let f = e.kind === "folder" ? e.path : parentOf(e.path); f; f = parentOf(f)) this.folders.add(f);
      if (e.kind === "open" && !this.editor?.dirty) this.show(e.path, cx);
    }
    this.refresh(cx);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openMenu({ root: this.root, path, dir: entry.dir, local: !this.on }); })
        .child(entry.dir ? svg(`mods/relevo-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/relevo-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  close() {
    this.editor?.close();
  }

  render(cx) {
    this.follow(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), ed = this.editor;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.back(cx)).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(ed), el => el.child(ed.controls(t))))
      .when(this.leaving, el => el.child(h_flex().h(32).flex_none().px(12).gap(8).items_center().bg(t.raised ?? t.surface).border_b(1).border_color(t.border).text_size(13)
        .child(div().flex_1().child("Unsaved changes"))
        .child(div().id("files-discard").px(8).h(22).flex().items_center().rounded(5).cursor_pointer().border(1).border_color(t.border).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.show(null); cx.notify(); }).child("Discard"))
        .child(div().id("files-save").px(8).h(22).flex().items_center().rounded(5).cursor_pointer().bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground)
          .on_click((_e, cx) => cx.spawn(async cx => { await ed.save(cx); if (!ed.dirty) { this.show(null); cx.notify(); } })).child("Save"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .on_mouse_down("right", () => { if (this.root) openMenu({ root: this.root, path: "", dir: true, local: !this.on }); })
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(13).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(ed), el => el.child(ed.body(t)));
  }
}

const ROLES = { menu: FileMenu, name: NameDialog, view: FileView };

export default class RelevoFiles extends View {
  init(_props, cx) {
    this.part = new (ROLES[props()?.role] ?? Files)();
    this.part.init?.(props(), cx);
  }

  close(cx) {
    return this.part.close?.(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
