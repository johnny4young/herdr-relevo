// The right-click menu on the tree and the name dialog behind New file, New folder and Rename.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, writeTextFile, props, openOverlay, closeOverlay, notify, theme, shared, setShared } from "herdr";
import { nameError, join, baseName, parentOf, targetFolder } from "./lib/paths.js";

// Tells every tree copy what happened, so it can open, follow or drop the path.
export function announce(event) {
  setShared("relevo-files.event", { ...event, n: ((shared("relevo-files.event") ?? {}).n ?? 0) + 1 });
}

export function openMenu(target) {
  openOverlay({ mod: "relevo-files", kind: "popup", width: 210, props: { role: "menu", ...target } });
}

const exists = async (path) => (await exec("test", ["-e", path])).code === 0 || (await exec("test", ["-L", path])).code === 0;

async function create(root, rel, dir) {
  const abs = join(root, rel);
  if (await exists(abs)) throw new Error(`${baseName(rel)} already exists`);
  if (dir) {
    const r = await exec("mkdir", [abs]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot create the folder");
  } else await writeTextFile(abs, "", null);
}

async function rename(root, from, to) {
  const src = join(root, from), dst = join(root, to);
  if (await exists(dst)) throw new Error(`${baseName(to)} already exists`);
  const r = await exec("mv", ["-n", src, dst]);
  if (r.code !== 0 || (await exists(src)) || !(await exists(dst))) throw new Error(r.stderr.trim() || "Cannot rename");
}

async function trash(root, rel) {
  const r = await exec("/usr/bin/trash", [join(root, rel)]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot move to Trash");
}

export class FileMenu {
  render() {
    const t = theme(), p = props() ?? {}, { root, path = "", dir, local, overlay } = p;
    const abs = join(root, path), isRoot = !path;
    // An act that returns true closes the menu itself once its work is done.
    const item = (id, label, act) => div().id(`fm-${id}`).h(28).px(10).flex().items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (act(cx) !== true) closeOverlay(overlay);
      })
      .child(label);
    const ask = (mode) => () => openOverlay({
      mod: "relevo-files", kind: "dialog", width: 380, props: { role: "name", mode, root, path, dir },
    });
    const sep = () => div().h(1).my(4).mx(6).bg(t.border);
    return v_flex().id("file-menu").w_full().p(4).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(12.5)
      .when(local, (el) => el
        .child(item("new-file", "New file", ask("new-file")))
        .child(item("new-folder", "New folder", ask("new-folder")))
        .when(!isRoot, (el) => el
          .child(item("rename", "Rename", ask("rename")))
          .child(item("trash", "Move to Trash", (cx) => {
            cx.spawn(async () => {
              try {
                await trash(root, path);
                announce({ kind: "trashed", root, path });
                notify({ title: "Moved to Trash", body: baseName(path), level: "success", timeout: 2500 });
              } catch (e) {
                notify({ title: "Not moved to Trash", body: String(e?.message ?? e), level: "error" });
              }
              closeOverlay(overlay);
            });
            return true;
          })))
        .child(sep())
        .child(item("reveal", "Reveal in Finder", () => exec("open", ["-R", abs]))))
      .child(item("copy", "Copy path", (cx) => cx.write_to_clipboard(abs)))
      .when(!isRoot, (el) => el.child(item("copy-rel", "Copy relative path", (cx) => cx.write_to_clipboard(path))));
  }
}

const TITLES = { "new-file": "New file", "new-folder": "New folder", rename: "Rename" };

export class NameDialog {
  init() {
    const { mode, path = "" } = props() ?? {};
    this.input = InputState.new({ value: mode === "rename" ? baseName(path) : "", placeholder: "Name" });
    this.input.on("change", (_e, cx) => {
      if (!this.error) return;
      this.error = null;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
  }

  submit(cx) {
    if (this.busy) return;
    const { mode, root, path = "", dir, overlay } = props() ?? {}, name = this.input.value();
    this.error = nameError(name);
    if (this.error) return cx.notify();
    const folder = mode === "rename" ? parentOf(path) : targetFolder({ path, dir });
    const rel = join(folder, name);
    if (mode === "rename" && rel === path) return closeOverlay(overlay);
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (mode === "rename") {
          await rename(root, path, rel);
          announce({ kind: "moved", root, path, to: rel });
        } else {
          await create(root, rel, mode === "new-folder");
          announce({ kind: mode === "new-folder" ? "folder" : "open", root, path: rel });
        }
        closeOverlay(overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  close() {
    this.input.release();
  }

  render() {
    const t = theme(), { mode, path = "", dir } = props() ?? {};
    const where = mode === "rename" ? parentOf(path) : targetFolder({ path, dir });
    return v_flex().id("name-dialog").w_full().p(16).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(12.5)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .child(h_flex().gap(6).items_center()
        .child(div().font_semibold().child(TITLES[mode] ?? ""))
        .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`in ${where}`))))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1)
        .border_color(this.error ? t.ansi1 : t.accent).bg(t.background))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.error)));
  }
}
