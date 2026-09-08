const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkerWHostAdapter } = require('../src/workerw-host-adapter');

function createNative() {
  const calls = [];
  const nativeHost = {
    calls,
    attach(handle, bounds, scaleFactor) { calls.push(['attach', handle.id, bounds.x, scaleFactor]); return { success: true, worker: 'worker-1' }; },
    observe(handle, state, bounds, scaleFactor, mode, operation) { calls.push([operation, handle.id, state?.worker, bounds.x, scaleFactor, mode]); return { success: true, structureValid: true, clientValid: true }; },
    setInputMode(handle, state, mode, bounds) { calls.push(['input', handle.id, state?.worker, mode, bounds.x]); return { success: true }; },
    setGeometry(handle, state, bounds) { calls.push(['geometry', handle.id, state?.worker, bounds.x]); return { success: true }; },
    restore(handle, state) { calls.push(['restore', handle.id, state?.worker]); return { success: true, parent: 0 }; }
  };
  return nativeHost;
}

function bounds(x = 10) {
  return { x, y: 20, width: 360, height: 160, unit: 'dip' };
}

test('maps WorkerW native operations to the HostService adapter contract', async () => {
  const nativeHost = createNative();
  const window = { id: 'widget-window', closed: false, close() { this.closed = true; } };
  const adapter = new WorkerWHostAdapter({
    nativeHost,
    createWindow: async () => window,
    getDisplay: () => ({ scaleFactor: 1.5 })
  });
  const created = await adapter.create({ instanceId: 'system-monitor-1' }, bounds());
  assert.equal(created.handle, window);
  const attached = await adapter.attach(window, 'primary', bounds(), 1);
  assert.equal(attached.success, true);
  assert.equal(attached.state.scaleFactor, 1.5);
  const validated = await adapter.validate(window, attached.state, bounds(30), 'locked', 1);
  assert.equal(validated.success, true);
  await adapter.setInputMode(window, attached.state, 'editing', bounds(30), 1);
  await adapter.setGeometry(window, attached.state, bounds(40), 1);
  const recovered = await adapter.recover(window, attached.state, 2, bounds(50));
  assert.equal(recovered.success, true);
  const destroyed = await adapter.destroy(window, recovered.state, 3);
  assert.equal(destroyed.success, true);
  assert.equal(window.closed, true);
  assert.deepEqual(nativeHost.calls.map(call => call[0]), ['attach', 'validate', 'input', 'geometry', 'restore', 'attach', 'restore']);
});

test('keeps native failure structured and does not close a live window', async () => {
  const nativeHost = createNative();
  nativeHost.restore = () => ({ success: false, errors: ['native detail'] });
  const window = { id: 'widget-window', closed: false, close() { this.closed = true; } };
  const adapter = new WorkerWHostAdapter({ nativeHost, createWindow: () => window });
  const result = await adapter.destroy(window, { nativeState: { worker: 'worker-1' }, scaleFactor: 1.5 }, 1);
  assert.equal(result.success, false);
  assert.equal(window.closed, false);
  assert.deepEqual(result.errors, ['native detail']);
});

test('uses a registered BrowserWindow before invoking its fallback factory', async () => {
  const nativeHost = createNative();
  let factoryCalls = 0;
  const registered = { id: 'registered' };
  const adapter = new WorkerWHostAdapter({ nativeHost, createWindow: () => { factoryCalls += 1; return { id: 'factory' }; } });
  adapter.registerWindow('clock-date-1', registered);
  const created = await adapter.create({ instanceId: 'clock-date-1' }, bounds());
  assert.equal(created.handle, registered);
  assert.equal(factoryCalls, 0);
  const fallback = await adapter.create({ instanceId: 'clock-date-2' }, bounds());
  assert.equal(fallback.handle.id, 'factory');
  assert.equal(factoryCalls, 1);
});
