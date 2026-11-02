// One file in a code view that can switch to editing: ⌘S saves only over what was read,
// and a change on disk while editing asks Reload or Keep mine.
import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings } from "herdr";
import { languageOf, textState, parentOf } from "./lib/paths.js";

async function sizeOf(path) {
  const r = await exec("stat", ["-f", "%z", path]).catch(() => null);
  return r?.code === 0 ? Number(r.stdout.trim()) : null;
}

export class FileEditor {
  // `local`: the file is on this computer; only then can it be written.
  constructor(path, local = true) {
    this.path = path;
    this.local = local;
    this.state = null;
    this.base = null;
    this.error = null;
    this.editable = false;
    this.editing = false;
    this.dirty = false;
    this.disk = undefined; // the newer text on disk while it differs from what was read
    this.note = null;
    this.open = true;
    this.loadVersion = 0;
    this.editVersion = 0;
  }

  async load(cx, read = (p) => readTextFile(p), discard = false) {
    if (!this.open || this.saving) return;
    const version = ++this.loadVersion, state = this.state;
    const value = state?.value(), edits = this.editVersion;
    const current = () => this.open && version === this.loadVersion && !this.saving;
    const edited = () => this.state !== state || this.editVersion !== edits || this.state?.value() !== value;
    try {
      const [text, bytes] = await Promise.all([read(this.path), this.local ? sizeOf(this.path) : null]);
      if (!current()) return;
      // Reload may discard edits present when clicked, never edits made while reading.
      if (edited() || (this.dirty && !discard)) {
        this.disk = text === this.base ? undefined : text;
        cx.notify();
        return;
      }
      const s = textState(text, bytes);
      this.error = s.error ?? null;
      this.editable = this.local && Boolean(s.editable);
      this.base = s.editable ? text : null;
      this.disk = undefined;
      this.dirty = false;
      if (!this.editable) this.editing = false;
      this.make(s.error ? null : s.value);
    } catch {
      if (!current()) return;
      if (edited() || this.dirty) this.note = "Cannot reload this file; your edits were kept";
      else this.error = "Cannot preview this file (binary, too large, or unreadable)";
    }
    cx.notify();
    if (this.local) this.watch(cx);
  }

  make(value) {
    this.state?.release();
    this.state = null;
    if (value === null) return;
    const t = theme();
    this.state = EditorState.new({
      language: languageOf(this.path), readonly: !this.editing, value,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    if (this.editing) {
      this.state.on("change", (_e, cx) => {
        this.editVersion++;
        if (this.dirty) return;
        this.dirty = true;
        cx.notify();
      });
    }
  }

  watch(cx) {
    if (this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      try {
        while (this.open) {
          const changed = await watchFolder(parentOf(this.path));
          if (!this.open) return;
          if (changed.includes(this.path)) await this.changedOnDisk(cx);
        }
      } catch { /* the folder went away; the next read says so */ }
      this.watching = false;
    });
  }

  async changedOnDisk(cx) {
    const text = await readTextFile(this.path).catch(() => null);
    if (!this.open || text === this.base) return;
    if (this.dirty) {
      this.disk = text;
      cx.notify();
    } else await this.load(cx);
  }

  edit(cx) {
    if (!this.editable || this.editing) return;
    this.editing = true;
    this.make(this.state?.value() ?? this.base);
    cx.notify();
  }

  save(cx) {
    if (this.saving) return this.saving;
    if (!this.open || !this.editing || !this.state) return;
    ++this.loadVersion; // Any older read predates this write and must not replace it.
    const state = this.state, path = this.path, text = state.value(), base = this.base;
    const current = () => this.open && this.state === state && this.path === path;
    // A second click/shortcut waits for this write instead of racing its old base.
    this.saving = (async () => {
      try {
        await writeTextFile(path, text, base);
        if (!current()) return;
        this.base = text;
        // Editing remains enabled while saving. Only the captured text is on disk.
        this.dirty = state.value() !== text;
        this.disk = undefined;
        if (!this.dirty) this.flash("Saved", cx);
      } catch (e) {
        if (!current()) return;
        const disk = await readTextFile(path).catch(() => null);
        if (!current()) return;
        if (disk !== this.base) this.disk = disk;
        else this.note = `Not saved: ${String(e?.message ?? e)}`;
      } finally {
        this.saving = null;
        if (current()) cx.notify();
      }
    })();
    return this.saving;
  }

  // Writes over whatever is on disk now; null there means it was deleted and is created again.
  async keepMine(cx) {
    if (this.saving) return this.saving;
    const expected = this.disk ?? null;
    this.disk = undefined;
    this.base = expected;
    await this.save(cx);
  }

  async reload(cx) {
    await this.load(cx, undefined, true);
  }

  flash(text, cx) {
    this.note = text;
    cx.timer.after(1500, (cx) => {
      if (this.note !== text) return;
      this.note = null;
      cx.notify();
    });
  }

  close() {
    this.open = false;
    this.state?.release();
    this.state = null;
  }

  key(e, cx) {
    if (e.modifiers.platform && !e.modifiers.shift && e.key === "s") {
      cx.stop_propagation();
      cx.spawn(async (cx) => this.save(cx));
    }
  }

  // Edit or the save state, for the caller's header.
  controls(t) {
    const button = (id, label, onClick, strong) => div().id(id).h(22).px(8).flex_none().flex().items_center().rounded(5)
      .cursor_pointer().text_size(11.5)
      .when(strong, (el) => el.bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground))
      .when(!strong, (el) => el.border(1).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
    return h_flex().flex_none().gap(6).items_center()
      .when(Boolean(this.note), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.note)))
      .when(this.dirty, (el) => el.child(div().size(7).rounded_full().bg(t.ansi3).tooltip("Unsaved changes")))
      .when(this.editable && !this.editing, (el) => el.child(button("fe-edit", "Edit", (cx) => this.edit(cx))))
      .when(this.editing && this.dirty, (el) => el.child(
        button("fe-save", "Save", (cx) => cx.spawn(async (cx) => this.save(cx)), true).tooltip("⌘S")));
  }

  body(t) {
    const conflict = this.disk !== undefined;
    return v_flex().id("fe-body").flex_1().min_h(0).on_key_down((e, cx) => this.key(e, cx))
      .when(conflict, (el) => el.child(h_flex().h(32).flex_none().px(12).gap(8).items_center()
        .bg(t.raised ?? t.surface).border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground)
          .child(this.disk === null ? "Deleted on disk" : "Changed on disk"))
        .child(div().id("fe-reload").px(8).h(22).flex().items_center().rounded(5).cursor_pointer()
          .border(1).border_color(t.border).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.reload(cx))).child("Reload"))
        .child(div().id("fe-keep").px(8).h(22).flex().items_center().rounded(5).cursor_pointer()
          .bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground)
          .on_click((_e, cx) => cx.spawn(async (cx) => this.keepMine(cx))).child("Keep mine"))))
      .child(this.state
        ? Editor.new(this.state).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.error ?? "Loading file…"));
  }
}
