import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { exec, home, readTextFile, notify } from "herdr";
import { SNOOZE_PRESETS, isSnoozed, pruneSnoozed, snoozeLabel, snoozeUntil } from "./lib/snooze.js";
import { button, foldRow, icon, keycap } from "./ui.js";

const SNOOZE_FILE = ".local/state/relevo/snoozed.json";

// Snooze persistence + contextual Action Panel (⌘K / ⋯). Mixed into Inbox.
export class ActionViews {
  loadSnoozed(cx) {
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${home()}/${SNOOZE_FILE}`);
        if (raw) {
          this.snoozed = pruneSnoozed(JSON.parse(raw));
          cx.notify();
        }
      } catch {
        this.snoozed = this.snoozed ?? {};
      }
    });
  }

  saveSnoozed() {
    this.snoozed = pruneSnoozed(this.snoozed);
    const body = JSON.stringify(this.snoozed, null, 2);
    const path = `${home()}/${SNOOZE_FILE}`;
    const write = () => exec("sh", ["-c",
      'umask 077 && d=$(dirname "$1") && mkdir -p "$d" && t=$(mktemp "$d/.snoozed.XXXXXX") && printf "%s" "$2" > "$t" && mv "$t" "$1"',
      "sh", path, body]).catch(() => {});
    this.snoozeWrite = (this.snoozeWrite ?? Promise.resolve()).then(write, write);
  }

  isRowSnoozed(id, meta = {}) {
    const entry = this.snoozed?.[id];
    return isSnoozed(entry, meta);
  }

  snoozeRow(id, presetKey, meta, cx) {
    this.snoozed = { ...(this.snoozed ?? {}), [id]: snoozeUntil(presetKey, meta) };
    this.saveSnoozed();
    this.lastMark = (c) => this.unsnoozeRow(id, c);
    this.closeActionMenu(cx);
    this.publish();
    cx.notify();
  }

  unsnoozeRow(id, cx) {
    if (!this.snoozed?.[id]) return;
    const next = { ...this.snoozed };
    delete next[id];
    this.snoozed = next;
    this.saveSnoozed();
    this.publish();
    cx.notify();
  }

  snoozeItems(entry) {
    if (!entry?.snooze) return [];
    const { id, ci, updatedAt, label } = entry.snooze;
    return SNOOZE_PRESETS
      .filter((p) => !p.untilCi || (ci && ci !== "SUCCESS"))
      .map((p) => ({
        id: `snooze-${p.key}-${id}`,
        label: `Snooze · ${p.label}`,
        section: "Snooze",
        run: (cx) => this.snoozeRow(id, p.key, { since: updatedAt, label }, cx),
      }));
  }

  actionMenuItems(entry, mode = "actions") {
    if (!entry) return [];
    if (mode === "snooze") return this.snoozeItems(entry);
    const raw = (entry.allActions?.() ?? []).filter(Boolean);
    const items = raw.map((a, i) => ({
      id: a.id ?? `act-${i}`,
      label: typeof a.label === "string" ? a.label : a.text ?? a.tip ?? a.id ?? "Action",
      key: a.key ?? null,
      tip: a.tip ?? null,
      el: a.el ?? null,
      run: a.run ?? null,
      section: "Actions",
    }));
    if (entry.copyUrl) {
      items.push({
        id: `copy-url-${entry.id}`,
        label: "Copy PR URL",
        section: "Actions",
        run: (cx) => {
          exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "sh", entry.copyUrl]).catch(() => {});
          notify({ title: "Copied PR URL", body: entry.copyUrl, level: "info", timeout: 1500 });
          this.closeActionMenu(cx);
        },
      });
    }
    return [...items, ...this.snoozeItems(entry)];
  }

  openActionMenu(entry, cx, { mode = "actions" } = {}) {
    if (!entry) return;
    const items = this.actionMenuItems(entry, mode);
    if (!items.length) return;
    this.actionMenu = { entry, mode };
    this.actionAt = 0;
    this.actionQuery?.set_value("");
    this.actionQuery?.focus();
    cx.notify();
  }

  closeActionMenu(cx) {
    if (!this.actionMenu) return;
    this.actionMenu = null;
    this.actionAt = 0;
    this.actionQuery?.set_value("");
    this.h?.focus();
    cx.notify();
  }

  filteredActionMenu() {
    if (!this.actionMenu) return [];
    const items = this.actionMenuItems(this.actionMenu.entry, this.actionMenu.mode);
    const q = (this.actionQuery?.value() ?? "").trim().toLowerCase();
    if (!q) return items;
    const terms = q.split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const hay = `${item.label} ${item.section ?? ""} ${item.tip ?? ""} ${item.key ?? ""}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }

  runActionMenu(cx, item = null) {
    const list = this.filteredActionMenu();
    const chosen = item ?? list[this.actionAt ?? 0];
    if (!chosen) return;
    this.actionMenu = null;
    this.actionAt = 0;
    this.actionQuery?.set_value("");
    this.h?.focus();
    if (chosen.run) chosen.run(cx);
    cx.notify();
  }

  actionMenuKey(e, cx) {
    if (!this.actionMenu) return false;
    const list = this.filteredActionMenu(), n = list.length;
    if (e.key === "escape") {
      this.closeActionMenu(cx);
      cx.stop_propagation();
      return true;
    }
    if ((e.key === "down" || e.key === "up") && n) {
      this.actionAt = ((this.actionAt ?? 0) + (e.key === "down" ? 1 : n - 1)) % n;
      cx.stop_propagation();
      cx.notify();
      return true;
    }
    if (e.key === "enter" && n) {
      this.runActionMenu(cx);
      cx.stop_propagation();
      return true;
    }
    return false;
  }

  renderActionMenu(t) {
    if (!this.actionMenu) return null;
    const list = this.filteredActionMenu();
    const at = Math.min(this.actionAt ?? 0, Math.max(0, list.length - 1));
    const heading = this.actionMenu.mode === "snooze" ? "Snooze until…" : `Actions · ${this.actionMenu.entry.title ?? ""}`;
    return v_flex().id("inbox-action-menu").flex_none().mx(8).my(4).p(8).gap(6).rounded(8)
      .bg(t.popover ?? t.background).border_1().border_color(t.accent)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted).child(heading))
        .child(button(t, "action-menu-close", [icon("x")], (cx) => this.closeActionMenu(cx), { kind: "ghost", size: "sm", tip: "Close · Esc" })))
      .when(this.actionMenu.mode === "actions", (el) => el.child(h_flex().id("action-menu-filter").h(28).px(8).gap(6)
        .items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
        .child(icon("search", t.dim)).child(div().flex_1().min_w(0).child(Input.new(this.actionQuery).h_full()))))
      .child(v_flex().id("action-menu-list").max_h(220).overflow_y_scrollbar().gap(2)
        .when(!list.length, (el) => el.child(div().p(6).text_size(11).text_color(t.dim).child("No matching actions")))
        .children(list.map((item, i) => {
          if (item.el && !item.run) {
            return h_flex().id(`am-wrap-${item.id}`).px(4).py(2).rounded(5).items_center()
              .when(i === at, (el) => el.bg(t.selected))
              .child(typeof item.el === "function" ? item.el() : item.el);
          }
          return button(t, item.id, [
            item.key ? keycap(t, item.key) : null,
            div().flex_1().min_w(0).truncate().child(item.label),
          ].filter(Boolean), (cx) => this.runActionMenu(cx, item), {
            kind: "ghost", size: "sm", selected: i === at, tip: item.tip,
          }).w_full().justify_start();
        })));
  }

  snoozedGroup(t) {
    const entries = Object.entries(pruneSnoozed(this.snoozed));
    if (!entries.length) return [];
    const now = Date.now() / 1000;
    return [
      foldRow(this, t, "maintenance-snoozed", "maintenance-snoozed", `${entries.length} snoozed`, { gap: true }),
      ...(this.expanded["maintenance-snoozed"] ? entries.map(([id, entry]) => h_flex().id(`snoozed-row-${id}`)
        .h(30).pl(24).pr(8).gap(8).items_center().rounded(6)
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(entry.label || id))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(snoozeLabel(entry, now)))
        .child(button(t, `unsnooze-${id}`, "Wake", (cx) => this.unsnoozeRow(id, cx), { size: "sm", tip: "Return to Now" }))) : []),
    ];
  }
}
