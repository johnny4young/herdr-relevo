import { element } from "./ui.mjs";

export class View {}
export const div = () => element("div");
// The path is kept so a test can tell which glyph was drawn.
export const svg = (path) => Object.assign(element("svg"), { src: path });
// Every item is drawn, and `keys` holds what on_item_click would report for each.
export const list = (id, count = 0, key = String, render = () => null) => {
  const at = Array.from({ length: count }, (_, i) => i);
  return Object.assign(element("list").id(id).children(at.map((i) => render(i))), { keys: at.map((i) => key(i)) });
};
// Every row is in view at once, and `keys` holds what on_item_click would report for each.
export const uniform_list = (id, count = 0, key = String, render = () => []) => {
  const at = Array.from({ length: count }, (_, i) => i);
  return Object.assign(element("list").id(id).children(render({ start: 0, end: count })), { keys: at.map((i) => key(i)) });
};
export const image = () => element("image");
