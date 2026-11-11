// Catches names a mod uses but never defines, which `herdr-app check` misses inside handlers it doesn't run.
const shared = { console: "readonly", fetch: "readonly", globalThis: "readonly", localStorage: "readonly" };

export default [
  {
    files: ["mods/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: shared },
    rules: { "no-undef": "error", "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }] },
  },
  {
    files: ["mods/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...shared, process: "readonly", Buffer: "readonly" } },
    rules: { "no-undef": "error" },
  },
];
