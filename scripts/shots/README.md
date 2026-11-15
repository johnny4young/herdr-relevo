# shots

Draws Relevo's real mod code to pictures: the mods load under Node with recording fakes for `herdr`, `gpui-kit` and
`gpui-base`, the element tree becomes HTML with inline styles, and headless Chrome takes the picture. The README's
preview and pictures come from here.

```sh
node scripts/shots/readme.mjs                 # every README picture, written in place
node scripts/shots/readme.mjs --only runs     # the ones whose file name holds "runs"
cd scripts/shots
node --import ./register.mjs shoot.mjs scenes/inbox-today.mjs /tmp/now.png           # one panel, PNG and HTML
THEME=day node --import ./register.mjs shoot.mjs scenes/agents-today.mjs /tmp/a.png --width 268 --height 600
node gaps.mjs   # builder methods used in the mods that kit.mjs has no CSS for
```

`readme.mjs` lists each panel (scene, size, environment) and each picture (page size, frames); a frame is a panel or a
drawn terminal from `terms/`. Run it after a change to a screen the README shows, look at every picture, and commit the
ones that changed for a reason (a clock in a panel changes on every run). `shoot.mjs` writes `x.png` and `x.html`; open
the HTML to inspect an element (each has `data-id` and `data-kind`). `--html-only` skips Chrome.

Env: `THEME=moon|graphite|day` (default moon), `LINE_HEIGHT` (default 1.618, GPUI's default), `RELEVO_REPO` (another
checkout to draw), `HERDR_APP_HOME` (where app icons such as `mods/workspace-chrome/*.svg` are read from), `CHROME`.
Scenes take their own switches: `STATE` (states), `RUN`, `TASK`, `TWICE`, `COMPARE`, `PICK` (runs), `SEL` (inbox),
`OPEN_DESK` (agents).

## Writing a scene

A scene is a module whose default export sets the fake app's state, builds the real view and returns its element:

```js
export default async function scene({ fake, theme, cx, flush, load }) {
  fake.agents = [...];            // also terminals, panes, spaces, focused, layout, props
  fake.stored["agents.sort"] = "grouped";            // shared(key)
  fake.files["/home/demo/x.json"] = "{}";            // readTextFile(path)
  fake.exec = (cmd, args, options) => (cmd === "git" ? { stdout: "..." } : null);   // null: exit 0, no output
  localStorage.setItem("since", "{}");
  const { Inbox } = await load("mods/relevo/inbox.js");   // a path in the repo
  const view = new Inbox();
  view.init({}, cx);
  await flush();                  // lets the scans the view spawned finish
  return { el: view.render(cx), width: 380, height: 800 };   // or just the element
}
```

Also passed in: `find(el, id)` and `click(node, cx)` to press a button before the final `render`, `fakeCx({ focused: true })`
for a view that holds the keyboard, `themeName`, `resetFake`, `repo`. Any element works as the return value, so a scene can
wrap one piece (`button(theme, ...)` from `mods/relevo/ui.js`) in a `div()` from `../kit.mjs`.

Home is `/home/demo`. Use demo names only.

## What is approximate

- Hover, focus and active styles are never applied; spinners are still.
- `Button` is drawn as a centered flex row holding its children directly.
- Scroll areas clip; nothing scrolls.
- Tokens the boards don't give (`ansi0/4/6/7`, `popover`, `input`, `accent_foreground`) are derived in `herdr.mjs`.
- An unmapped builder method or theme token is logged once to stderr and listed at the end of the run.
