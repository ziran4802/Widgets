const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppService, AppServiceError } = require('../src/app-service');
const { ConfigStore } = require('../src/config-store');
const { createDefaultConfig } = require('../src/config-contract');

function serviceWithTempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-service-'));
  const store = new ConfigStore({ filePath: path.join(root, 'settings', 'config.json') });
  return { root, store, service: new AppService({ store, now: () => new Date('2026-09-06T00:00:00.000Z') }) };
}

test('starts degraded with empty defaults, then persists a component transaction', async () => {
  const { store, service } = serviceWithTempStore();
  const initial = await service.start();
  assert.equal(initial.app.phase, 'degraded');
  assert.equal(initial.app.lastError.code, 'CONFIG_RECOVERY_REQUIRED');
  const component = await service.addComponent('system-monitor');
  assert.equal(component.instanceId, 'system-monitor-1');
  assert.equal(service.snapshot().app.phase, 'ready');
  const restarted = new AppService({ store, now: () => new Date('2026-09-06T00:02:00.000Z') });
  const restored = await restarted.start();
  assert.equal(restored.app.configSource, 'primary');
  assert.equal(restored.catalog.components[0].instanceId, 'system-monitor-1');
});

test('persists the larger Codex quota default size during startup migration', async () => {
  const { store } = serviceWithTempStore();
  const legacy = {
    ...createDefaultConfig(),
    components: [{
      instanceId: 'codex-quota-1',
      type: 'codex-quota',
      schemaVersion: 1,
      displayName: 'Codex 额度',
      visible: true,
      locked: true,
      displayId: null,
      bounds: { x: -80, y: 120, width: 520, height: 250, unit: 'dip' },
      theme: { name: 'system', opacity: 0.92 },
      config: {}
    }]
  };
  await store.save(legacy, new Date('2026-09-06T00:00:00.000Z'));
  const service = new AppService({ store, now: () => new Date('2026-09-06T00:01:00.000Z') });
  const snapshot = await service.start();
  assert.deepEqual(snapshot.catalog.components[0].bounds, { x: -80, y: 120, width: 680, height: 300, unit: 'dip' });
  const persisted = await store.load();
  assert.deepEqual(persisted.config.components[0].bounds, { x: -80, y: 120, width: 680, height: 300, unit: 'dip' });
});

test('edit is memory-only until complete and cancel preserves the saved state', async () => {
  const { service } = serviceWithTempStore();
  await service.start();
  const component = await service.addComponent('clock-date');
  const before = service.snapshot().catalog.components[0].bounds;
  service.beginEdit(component.instanceId, 'session-1001');
  service.updateEdit('session-1001', { bounds: { x: 80, y: 90, width: 320, height: 140, unit: 'dip' } });
  assert.deepEqual(service.snapshot().catalog.components[0].bounds, before);
  service.cancelEdit('session-1001');
  service.beginEdit(component.instanceId, 'session-1002');
  service.updateEdit('session-1002', { bounds: { x: 80, y: 90, width: 320, height: 140, unit: 'dip' } });
  await service.completeEdit('session-1002');
  assert.deepEqual(service.snapshot().catalog.components[0].bounds, { x: 80, y: 90, width: 320, height: 140, unit: 'dip' });
});

test('persists a component position and restores it after restart', async () => {
  const { store, service } = serviceWithTempStore();
  await service.start();
  const component = await service.addComponent('system-monitor');
  await service.setPosition(component.instanceId, { x: -140, y: 260 });
  const restarted = new AppService({ store });
  const restored = await restarted.start();
  assert.deepEqual(restored.catalog.components[0].bounds, { x: -140, y: 260, width: 520, height: 190, unit: 'dip' });
});

test('persists a drag while an edit transaction is open without losing edit dimensions', async () => {
  const { service } = serviceWithTempStore();
  await service.start();
  const component = await service.addComponent('system-monitor');
  service.beginEdit(component.instanceId, 'session-1003');
  service.updateEdit('session-1003', { bounds: { x: 80, y: 90, width: 420, height: 180, unit: 'dip' } });
  await service.setPosition(component.instanceId, { x: 240, y: -80 });
  await service.completeEdit('session-1003');
  assert.deepEqual(service.snapshot().catalog.components[0].bounds, { x: 240, y: -80, width: 420, height: 180, unit: 'dip' });
});

test('cancelling an edit restores a dragged position and does not write it', async () => {
  const { store, service } = serviceWithTempStore();
  await service.start();
  const component = await service.addComponent('system-monitor');
  const original = service.snapshot().catalog.components[0].bounds;
  service.beginEdit(component.instanceId, 'session-1004');

  const moved = await service.setPosition(component.instanceId, { x: 240, y: -80 });
  assert.deepEqual(moved.bounds, { x: 240, y: -80, width: 520, height: 190, unit: 'dip' });
  assert.deepEqual(service.snapshot().catalog.components[0].bounds, original);

  service.cancelEdit('session-1004');
  assert.deepEqual(service.snapshot().catalog.components[0].bounds, original);
  const restarted = new AppService({ store });
  const restored = await restarted.start();
  assert.deepEqual(restored.catalog.components[0].bounds, original);
});

test('save failure leaves the committed catalog untouched and exposes a safe error', async () => {
  const calls = [];
  const store = {
    async load() { return { source: 'primary', config: createDefaultConfig(), errors: [] }; },
    async save() { calls.push('save'); const error = new Error('path must not reach UI'); error.code = 'CONFIG_WRITE_FAILED'; throw error; }
  };
  const service = new AppService({ store });
  await service.start();
  await assert.rejects(() => service.addComponent('system-monitor'), error => error instanceof AppServiceError && error.code === 'CONFIG_WRITE_FAILED');
  assert.equal(calls.length, 1);
  assert.equal(service.snapshot().catalog.components.length, 0);
  assert.equal(service.snapshot().app.lastError.message, '配置保存失败，已保留原配置');
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /path must not reach UI/);
});

test('autosaves note content and restores it after restart', async () => {
  const { store, service } = serviceWithTempStore();
  await service.start();
  const note = await service.addComponent('note');
  service.beginEdit(note.instanceId, 'session-note-2');
  service.updateEdit('session-note-2', { bounds: { x: 220, y: 240, width: 360, height: 300, unit: 'dip' } });
  await service.updateNoteContent(note.instanceId, { title: '标题', text: '自动保存的正文' });
  service.cancelEdit('session-note-2');
  const restarted = new AppService({ store });
  const restored = await restarted.start();
  assert.deepEqual(restored.catalog.components[0].config, { title: '标题', text: '自动保存的正文', size: 'standard', background: 'yellow' });
  assert.deepEqual(restored.catalog.components[0].bounds, { x: 320, y: 16, width: 300, height: 260, unit: 'dip' });
});

test('persists global appearance settings and restores them after restart', async () => {
  const { store, service } = serviceWithTempStore();
  await service.start();
  await service.updateSettings({ theme: 'light', opacity: 0.78 });
  const restarted = new AppService({ store });
  const restored = await restarted.start();
  assert.deepEqual(restored.catalog.settings, { theme: 'light', globalLocked: true, opacity: 0.78 });
});
