const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ failWrite = false, retainNoActivate = false, zero = 0n, enabledBefore = false } = {}) {
  let exStyle = 0x080000a0;
  let lastError = 0;
  let sampled;
  let enabled = enabledBefore;
  const functions = {
    IsWindowEnabled: () => enabled,
    EnableWindow: (_h, value) => { enabled = value; },
    GetParent: () => 2n,
    GetAncestor: () => 2n,
    GetWindowLongPtrW: (_h, index) => index === -16 ? 0x40000000 : exStyle,
    SetWindowLongPtrW: (_h, _index, value) => {
      const previous = exStyle;
      if (failWrite) { lastError = 5; return zero; }
      exStyle = value | (retainNoActivate ? 0x08000000 : 0);
      return previous;
    },
    GetLastError: () => lastError,
    SetLastError: value => { lastError = value; },
    SetWindowPos: () => true,
    GetWindowRect: (_h, b) => { [0, 0, 100, 100].forEach((v, i) => b.writeInt32LE(v, i * 4)); return true; },
    GetClientRect: (_h, b) => { [0, 0, 100, 100].forEach((v, i) => b.writeInt32LE(v, i * 4)); return true; },
    ClientToScreen: () => true,
    GetClassNameW: () => 0,
    WindowFromPoint: point => { sampled = point; return 1n; }
  };
  const koffi = {
    struct: fields => fields,
    load: () => ({ func: (signature, _result, parameters) => {
      const name = parameters ? signature : signature.match(/(\w+)\(/)[1];
      if (name === 'WindowFromPoint') {
        assert.equal(parameters?.[0]?.x, 'int32_t');
        assert.equal(parameters?.[0]?.y, 'int32_t');
      }
      return functions[name] || (() => 0);
    } })
  };
  const sandbox = {
    module: { exports: {} }, Buffer, process: { platform: 'win32' },
    require: name => name === 'koffi' ? koffi : require('../src/m0-contract')
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/native-host.js'), 'utf8'), sandbox);
  const host = sandbox.module.exports.loadNativeHostAdapter();
  assert.equal(host.available, true);
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(1n);
  return { host, window: { getNativeWindowHandle: () => handle }, state: { worker: 2n, scaleFactor: 1 },
    bounds: { x: 0, y: 0, width: 100, height: 100, unit: 'dip' }, sampled: () => sampled, enabled: () => enabled };
}

test('enables the disabled WorkerW for input and restores it on lock or detach', () => {
  const f = fixture();
  f.host.setInputMode(f.window, f.state, 'editing', f.bounds);
  assert.equal(f.enabled(), true);
  f.host.setInputMode(f.window, f.state, 'locked', f.bounds);
  assert.equal(f.enabled(), false);
  f.host.setInputMode(f.window, f.state, 'editing', f.bounds);
  f.host.restore(f.window, f.state);
  assert.equal(f.enabled(), false);
});

test('keeps WorkerW enabled until the last input owner releases it', () => {
  const f = fixture();
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(3n);
  const other = { getNativeWindowHandle: () => handle };
  const otherState = { ...f.state };
  f.host.setInputMode(f.window, f.state, 'editing', f.bounds);
  f.host.setInputMode(other, otherState, 'editing', f.bounds);
  f.host.setInputMode(f.window, f.state, 'locked', f.bounds);
  assert.equal(f.enabled(), true);
  f.host.setInputMode(other, otherState, 'locked', f.bounds);
  assert.equal(f.enabled(), false);
});

test('preserves an already enabled WorkerW after releasing input', () => {
  const f = fixture({ enabledBefore: true });
  f.host.setInputMode(f.window, f.state, 'editing', f.bounds);
  f.host.restore(f.window, f.state);
  assert.equal(f.enabled(), true);
});

test('native input rejects failed writes for numeric and bigint zero return values', () => {
  for (const zero of [0, 0n]) {
    const f = fixture({ failWrite: true, zero });
    const result = f.host.setInputMode(f.window, f.state, 'locked', f.bounds);
    assert.equal(result.structureValid, true);
    assert.equal(result.write.ok, false);
    assert.equal(result.success, false);
    assert.match(result.errors.join(' '), /failed:5/);
  }
});

test('native input rejects a lingering NOACTIVATE flag and accepts an actual unlock', () => {
  for (const retainNoActivate of [true, false]) {
    const f = fixture({ retainNoActivate });
    const result = f.host.setInputMode(f.window, f.state, 'editing', f.bounds);
    assert.equal(result.success, !retainNoActivate);
    assert.equal(f.state.inputMode, retainNoActivate ? undefined : 'editing');
  }
});

test('native hit sampling passes signed POINT coordinates by value', () => {
  const f = fixture();
  const result = f.host.samplePoint(f.window, { x: -25.5, y: 120.9 });
  assert.equal(f.sampled().x, -25);
  assert.equal(f.sampled().y, 120);
  assert.equal(Buffer.isBuffer(f.sampled()), false);
  assert.equal(result.hitIsCard, true);
});
