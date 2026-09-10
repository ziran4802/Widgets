const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputRoute } = require('../src/desktop-input-router');

function fixture() {
  const target = { window: {} };
  let active = true;
  const events = [];
  const route = createInputRoute({ getTargets: () => active ? [target] : [],
    inspect: (_target, point) => ({ x: point.x, y: point.y, desktopHit: point.x >= 0 && point.x < 100 }),
    deliver: (_target, event) => events.push(event) });
  return { route, events, disable: () => { active = false; } };
}

test('forwards a desktop click but leaves covering apps and unmatched releases alone', () => {
  const f = fixture();
  assert.equal(f.route(0x201, { x: 120, y: 20 }), false);
  assert.equal(f.route(0x202, { x: 20, y: 20 }), false);
  assert.equal(f.route(0x201, { x: 20, y: 20 }), true);
  assert.equal(f.route(0x202, { x: 20, y: 20 }), true);
  assert.deepEqual(f.events.map(event => event.message), [0x201, 0x202]);
});

test('completes an owned drag outside the widget and releases ownership', () => {
  const f = fixture();
  f.route(0x201, { x: 20, y: 20 });
  assert.equal(f.route(0x200, { x: 130, y: 20 }), true);
  assert.equal(f.route(0x202, { x: 130, y: 20 }), true);
  assert.equal(f.route(0x200, { x: 130, y: 20 }), false);
});

test('locking, hiding or destroying the target cancels forwarding', () => {
  const f = fixture();
  f.route(0x201, { x: 20, y: 20 });
  f.disable();
  assert.equal(f.route(0x202, { x: 20, y: 20 }), false);
  assert.equal(f.route(0x201, { x: 20, y: 20 }), false);
  assert.equal(f.events.length, 1);
});

test('forwards wheel data only inside the desktop target and ignores unrelated buttons', () => {
  const f = fixture();
  assert.equal(f.route(0x20a, { x: 20, y: 20 }, 120 << 16), true);
  assert.equal(f.events[0].mouseData, 120 << 16);
  assert.equal(f.route(0x204, { x: 20, y: 20 }), false);
});
