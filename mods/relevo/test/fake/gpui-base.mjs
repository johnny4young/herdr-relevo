import { element } from "./ui.mjs";

export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const Scrollbar = { vertical: () => element("scrollbar"), horizontal: () => element("scrollbar") };

const field = (options = {}) => {
  let value = options.value ?? "";
  return { value: () => value, set_value(next) { value = next; }, on() {}, focus() {}, release() {} };
};
export const InputState = { new: field };
export const EditorState = { new: field };
export const Input = { new: () => element("input") };
export const Editor = { new: () => element("editor") };
