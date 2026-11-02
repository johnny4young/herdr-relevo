// Answers the app's bare imports with these fakes, so tests load the real mods. Import it before a dynamic import of one.
import { registerHooks } from "node:module";
import { URL } from "node:url";

const FAKES = { herdr: "./herdr.mjs", "gpui-kit": "./gpui-kit.mjs", "gpui-base": "./gpui-base.mjs" };

registerHooks({
  resolve(specifier, context, next) {
    if (FAKES[specifier]) return { url: new URL(FAKES[specifier], import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => void stored.set(key, String(value)),
  removeItem: (key) => void stored.delete(key),
};
