// The left bar as main draws it: Spaces above the Agents queue, each half its height. Demo data only.
import spaces from "./spaces.mjs";
import agents from "./agents-today.mjs";

export default async function scene(ctx) {
  const height = Number(process.env.HEIGHT ?? 852);
  const { v_flex } = await ctx.load("scripts/shots/base.mjs");
  const top = await spaces(ctx);
  const bottom = await agents({ ...ctx, cx: ctx.fakeCx() });
  const half = Math.floor(height / 2);
  return { el: v_flex().w(268).h(height).child(v_flex().h(half).child(top.el)).child(v_flex().h(height - half).child(bottom.el)), width: 268, height };
}
