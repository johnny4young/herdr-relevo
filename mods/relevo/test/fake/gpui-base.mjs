import { element } from "./ui.mjs";

export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const Button = { new: (id) => element("button").id(id) };
export const Scrollbar = { vertical: () => element("scrollbar"), horizontal: () => element("scrollbar") };

const field = (options = {}) => {
  let value = options.value ?? "";
  const listeners = [];
  return {
    value: () => value, set_value(next) { value = next; }, on(name, fn) { listeners.push([name, fn]); }, focus() {}, release() {},
    type(next, cx) { value = next; listeners.filter(([name]) => name === "change").forEach(([, fn]) => fn({}, cx)); },
    submit(event, cx) { listeners.filter(([name]) => name === "submit").forEach(([, fn]) => fn(event, cx)); },
  };
};
export const InputState = { new: field };
export const TextareaState = { new: field };
export const EditorState = { new: field };
export const Input = { new: () => element("input") };
export const Textarea = { new: () => element("textarea") };
export const Editor = { new: () => element("editor") };
export const TextView = { markdown: (id, text) => element("textview").id(id).child(text), html: (id, text) => element("textview").id(id).child(text) };
