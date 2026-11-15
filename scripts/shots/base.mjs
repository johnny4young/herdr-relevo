// gpui-base stand-in: the same recording elements, plus text fields that show their state.
import { element } from "./kit.mjs";

export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const Button = { new: (id) => element("button").id(id) };
export const Link = { new: (id) => element("button").id(id) };
export const Checkbox = { new: (id) => element("checkbox").id(id) };
export const Switch = { new: (id) => element("switch").id(id) };
export const Scrollbar = { vertical: () => element("scrollbar"), horizontal: () => element("scrollbar") };
export const ScrollHandle = { new: () => ({ scroll_to_item() {}, scroll_to_top() {}, scroll_to_bottom() {}, offset: () => ({ x: 0, y: 0 }), release() {} }) };

const field = (options = {}) => {
  let value = options.value ?? "";
  const listeners = [];
  return {
    options, placeholder: options.placeholder ?? "",
    value: () => value, set_value(next) { value = next; }, on(name, fn) { listeners.push([name, fn]); }, focus() {}, release() {},
    type(next, cx) { value = next; listeners.filter(([name]) => name === "change").forEach(([, fn]) => fn({}, cx)); },
    submit(event, cx) { listeners.filter(([name]) => name === "submit").forEach(([, fn]) => fn(event, cx)); },
  };
};
export const InputState = { new: field };
export const TextareaState = { new: field };
export const EditorState = { new: field };
export const Input = { new: (state) => element("input", { state }) };
export const Textarea = { new: (state) => element("textarea", { state }) };
export const Editor = { new: (state) => element("editor", { state }) };
export const TextView = {
  markdown: (id, body) => element("textview").id(id).child(body),
  html: (id, body) => element("textview").id(id).child(body),
};
