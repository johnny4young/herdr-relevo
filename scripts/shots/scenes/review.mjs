// The review pane with demo data: three files, one with a range comment and a file comment.
export default async function scene({ cx, load }) {
  const { ReviewDiff } = await load("mods/relevo/review.js");
  const { diffRows, lineComment, fileComment } = await load("mods/relevo/lib/diff.js");
  const { highlightRows, languageFor } = await load("mods/relevo/lib/highlight.js");
  const v = new ReviewDiff();
  v.init({}, cx);
  v.key = "/demo"; v.root = "/demo";
  v.files = [
    { path: "src/limiter/clock.ts", add: 31, del: 0, added: true },
    { path: "src/limiter/bucket.ts", add: 9, del: 6, added: false },
    { path: "test/ratelimit.test.ts", add: 8, del: 0, added: false },
  ];
  v.open = v.files[0];
  v.hashes = new Map(v.files.map((f) => [f.path, `h-${f.path}`]));
  v.rows = highlightRows(diffRows(["@@ -0,0 +1,7 @@", "+export interface Clock { now(): number }", "+", "+// A clock tests can move by hand.",
    "+export function fixedClock(start = 0): Clock & { tick(ms: number): void } {", "+  let at = start;", "+  return { now: () => at, tick: (ms) => { at += ms; } };", "+}"]), languageFor(v.open.path));
  v.setComments([lineComment("src/limiter/clock.ts", v.rows, 4, 6, "Keep this in test/ only: production code should not import a clock that never advances."),
    fileComment("src/limiter/clock.ts", "Export it from the test helpers instead.")]);
  return { el: v.render(cx), width: 700, height: 600 };
}
