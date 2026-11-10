import './fake/register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { overlayHeight } = await import('../ui.js');

function withViewport(value, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value });
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
}

test('overlay height respects both the preferred size and viewport fraction', () => {
  withViewport({ viewport_size: () => ({ width: 900, height: 800 }) }, () => {
    assert.equal(overlayHeight(720, 0.88), 704);
    assert.equal(overlayHeight(620, 0.85), 620);
    assert.equal(overlayHeight(900, 0.85), 680);
  });
});

test('overlay height falls back to preferred size when viewport is missing or invalid', () => {
  withViewport(undefined, () => assert.equal(overlayHeight(720), 720));
  withViewport({}, () => assert.equal(overlayHeight(720), 720));
  withViewport({ viewport_size: () => null }, () => assert.equal(overlayHeight(720), 720));
  withViewport({ viewport_size: () => ({ height: 0 }) }, () => assert.equal(overlayHeight(720), 720));
  withViewport({ viewport_size: () => { throw Error('unavailable'); } }, () => assert.equal(overlayHeight(720), 720));
});

test('invalid fractions preserve preferred size', () => {
  withViewport({ viewport_size: () => ({ height: 400 }) }, () => {
    assert.equal(overlayHeight(720, 0), 720);
    assert.equal(overlayHeight(720, 1.2), 720);
  });
});
