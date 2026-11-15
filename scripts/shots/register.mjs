// Answers the app's bare imports with the recording fakes in this folder, so the real mods load under Node.
import { registerHooks } from "node:module";
import { URL } from "node:url";

const FAKES = { herdr: "./herdr.mjs", "gpui-kit": "./kit.mjs", "gpui-base": "./base.mjs" };

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
