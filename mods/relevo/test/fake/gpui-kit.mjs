import { element } from "./ui.mjs";

export class View {}
export const div = () => element("div");
// The path is kept so a test can tell which glyph was drawn.
export const svg = (path) => Object.assign(element("svg"), { src: path });
export const list = () => element("list");
export const image = () => element("image");
