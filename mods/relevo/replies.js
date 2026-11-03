import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec, notify, props, agents, openOverlay, closeOverlay } from "herdr";
import * as config from "./config.js";

// Older config.js files have no REPLIES; a missing named import would stop the whole mod.
export const DEFAULT_REPLIES = ["Continue", "Tested and it works: commit and push", "Fix all of it"];
export const replies = () => (Array.isArray(config.REPLIES) ? config.REPLIES : DEFAULT_REPLIES);

const nameOf = (a) => a.tab_name || a.space_name || a.address;

export function openReplies(address = agents().find((a) => a.focused)?.address) {
  const a = agents().find((x) => x.address === address);
  if (!a) return notify({ title: "No agent in focus", level: "info", timeout: 2000 });
  openOverlay({
    mod: "relevo", kind: "dialog", width: 480, height: 92 + 30 * replies().length,
    props: { role: "quick-replies", address: a.address, name: nameOf(a) },
  });
}

// Without --force, hc won't type into a question the agent is asking; a working agent queues the message.
export async function sendTo(address, name, text) {
  const r = await exec("hc", ["send", address, text]);
  if (r.code !== 0) {
    notify({ title: `Could not send to ${name}`, body: r.stderr.trim().split("\n")[0], level: "warning" });
    return false;
  }
  notify({ title: `Sent to ${name}`, body: text, level: "success", timeout: 2000 });
  return true;
}

// Enter sends what is typed, or the highlighted reply when nothing is.
export class QuickReplies {
  init(_props, cx) {
    this.at = 0;
    this.input = InputState.new({ value: "", placeholder: "Message, or pick one below" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.send(this.input.value().trim() || replies()[this.at], cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  close() {
    this.input.release();
  }

  send(text, cx) {
    const p = props();
    if (!text || this.sending) return;
    this.sending = true;
    cx.spawn(async () => {
      if (await sendTo(p.address, p.name, text)) closeOverlay(p.overlay);
      this.sending = false;
    });
  }

  key(e, cx) {
    const n = replies().length;
    if (e.key === "escape") return closeOverlay(props().overlay);
    if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme(), p = props(), typed = Boolean(this.input.value().trim());
    return v_flex().id("quick-replies").size_full().p(12).gap(8)
      .bg(t.popover ?? t.surface).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(div().text_size(11).text_color(t.dim).truncate().child(`To ${p?.name ?? ""}`))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background))
      .child(v_flex().id("quick-replies-list").flex_none()
        .children(replies().map((text, i) => h_flex().id(`reply-${i}`).h(30).px(8).flex_none().items_center().rounded(6)
          .cursor_pointer()
          .when(i === this.at && !typed, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.send(text, cx))
          .child(div().flex_1().min_w(0).truncate().child(text)))));
  }
}
