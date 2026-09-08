const test = require('node:test');
const assert = require('node:assert/strict');
const { HostService, HostServiceError } = require('../src/host-service');

function createAdapter(overrides = {}) {
  const calls = [];
  const adapter = {
    calls,
    async create(instance) { calls.push(['create', instance.instanceId]); return { handle: `handle:${instance.instanceId}`, state: { attached: false } }; },
    async attach(_handle, _display, _bounds, generation) { calls.push(['attach', generation]); return { operation: 'attach', success: true, state: { attached: true } }; },
    async validate(_handle, _state, _bounds, mode, generation) { calls.push(['validate', mode, generation]); return { operation: 'validate', success: true, state: { attached: true } }; },
    async setInputMode(_handle, _state, mode, _bounds, generation) { calls.push(['input', mode, generation]); return { operation: 'input', success: true }; },
    async setGeometry(_handle, _state, bounds, generation) { calls.push(['geometry', bounds.x, generation]); return { operation: 'geometry', success: true }; },
    async recover(_handle, _state, generation) { calls.push(['recover', generation]); return { operation: 'recover', success: true, state: { attached: true } }; },
    async detach(_handle, _state, generation) { calls.push(['detach', generation]); return { operation: 'detach', success: true }; },
    async destroy(_handle, _state, generation) { calls.push(['destroy', generation]); return { operation: 'destroy', success: true }; },
    ...overrides
  };
  return adapter;
}

function instance() {
  return { instanceId: 'system-monitor-1', bounds: { x: 10, y: 20, width: 360, height: 160, unit: 'dip' } };
}

test('manages host lifecycle, input mode, geometry and generation', async () => {
  const adapter = createAdapter();
  const service = new HostService({ adapter });
  const created = await service.create(instance());
  assert.deepEqual({ phase: created.phase, mode: created.mode, generation: created.generation }, { phase: 'created', mode: 'locked', generation: 1 });
  await service.attach('system-monitor-1', 'primary');
  const validated = await service.validate('system-monitor-1');
  assert.equal(validated.lastResult.operation, 'validate');
  assert.equal(validated.phase, 'ready');
  await service.setInputMode('system-monitor-1', 'editing');
  const moved = await service.setGeometry('system-monitor-1', { x: -40, y: 80, width: 360, height: 160, unit: 'dip' });
  assert.equal(moved.phase, 'editing');
  assert.deepEqual(moved.bounds, { x: -40, y: 80, width: 360, height: 160, unit: 'dip' });
  const recovered = await service.recover('system-monitor-1');
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.phase, 'editing');
  await service.setInputMode('system-monitor-1', 'locked');
  const detached = await service.detach('system-monitor-1');
  assert.equal(detached.phase, 'detached');
  await service.destroy('system-monitor-1');
  assert.deepEqual(service.getSnapshot(), []);
  assert.deepEqual(adapter.calls.map(call => call[0]), ['create', 'attach', 'validate', 'input', 'geometry', 'recover', 'input', 'detach', 'destroy']);
});

test('rejects invalid operations without changing the host record', async () => {
  const service = new HostService({ adapter: createAdapter() });
  await assert.rejects(() => service.create({ instanceId: 'bad', bounds: { x: 0, y: 0, width: 10, height: 10 } }), error => error instanceof HostServiceError && error.code === 'INVALID_BOUNDS');
  await service.create(instance());
  await assert.rejects(() => service.setInputMode('system-monitor-1', 'dragging'), error => error.code === 'INVALID_INPUT_MODE');
  await assert.rejects(() => service.setGeometry('system-monitor-1', { x: 0, y: 0, width: -1, height: 10, unit: 'dip' }), error => error.code === 'INVALID_BOUNDS');
  assert.equal(service.getSnapshot()[0].phase, 'created');
});

test('ignores a recovery result that returns after destroy', async () => {
  let resolveRecovery;
  const adapter = createAdapter({
    recover: (_handle, _state, generation) => new Promise(resolve => { resolveRecovery = () => resolve({ operation: 'recover', success: true, generation }); })
  });
  const service = new HostService({ adapter });
  await service.create(instance());
  const recovery = service.recover('system-monitor-1');
  await service.destroy('system-monitor-1');
  resolveRecovery();
  assert.deepEqual(await recovery, { ok: false, errorCode: 'STALE_OPERATION', generation: 2 });
  assert.deepEqual(service.getSnapshot(), []);
});

test('records adapter failures as recoverable host state', async () => {
  const adapter = createAdapter({
    setGeometry: async () => { throw new Error('native detail must stay private'); }
  });
  const service = new HostService({ adapter });
  await service.create(instance());
  await service.attach('system-monitor-1', 'primary');
  await assert.rejects(() => service.setGeometry('system-monitor-1', { x: 30, y: 40, width: 360, height: 160, unit: 'dip' }), error => error instanceof HostServiceError && error.code === 'HOST_GEOMETRY_FAILED');
  const failed = service.getSnapshot()[0];
  assert.equal(failed.phase, 'unavailable');
  assert.deepEqual(failed.lastResult, { operation: 'geometry', success: false, errorCode: 'HOST_GEOMETRY_FAILED' });
  const recovered = await service.recover('system-monitor-1');
  assert.equal(recovered.phase, 'ready');
});
