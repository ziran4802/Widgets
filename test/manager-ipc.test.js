const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/config-store');
const { AppService } = require('../src/app-service');
const { ManagerIpcRouter } = require('../src/manager-ipc');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-ipc-'));
  const store = new ConfigStore({ filePath: path.join(root, 'config.json') });
  const service = new AppService({ store, now: () => new Date('2026-09-06T00:00:00.000Z') });
  const router = new ManagerIpcRouter({ service, authorizeSender: context => context?.isManager === true && context?.isMainFrame === true });
  return { store, service, router };
}

function request(requestId, extra = {}) {
  return { schemaVersion: 1, requestId, ...extra };
}

test('rejects untrusted senders and malformed envelopes without touching service state', async () => {
  const { service, router } = setup();
  await service.start();
  const denied = await router.dispatch({ isManager: false, isMainFrame: true }, 'manager:get-snapshot', request('req-denied'));
  assert.deepEqual(denied, { schemaVersion: 1, requestId: 'req-denied', ok: false, errorCode: 'UNAUTHORIZED_SENDER', message: 'request source is not authorized' });
  const malformed = await router.dispatch({ isManager: true, isMainFrame: true }, 'manager:get-snapshot', { schemaVersion: 99, requestId: 'req-bad' });
  assert.equal(malformed.errorCode, 'INVALID_COMMAND');
  assert.equal(service.snapshot().catalog.components.length, 0);
});

test('routes add, visibility, snapshot and remove through the service', async () => {
  const { service, router } = setup();
  await service.start();
  const context = { isManager: true, isMainFrame: true };
  const added = await router.dispatch(context, 'manager:component-add', request('req-add', { payload: { type: 'system-monitor' } }));
  assert.equal(added.ok, true);
  const instanceId = added.component.instanceId;
  const hidden = await router.dispatch(context, 'manager:component-update', request('req-hide', { instanceId, payload: { field: 'visible', value: false } }));
  assert.equal(hidden.snapshot.catalog.components[0].visible, false);
  const snapshot = await router.dispatch(context, 'manager:get-snapshot', request('req-snapshot'));
  assert.equal(snapshot.snapshot.catalog.catalog[0].available, false);
  const removed = await router.dispatch(context, 'manager:component-remove', request('req-remove', { instanceId }));
  assert.equal(removed.snapshot.catalog.components.length, 0);
});

test('routes global appearance settings and returns the persisted snapshot', async () => {
  const { store, service, router } = setup();
  await service.start();
  const context = { isManager: true, isMainFrame: true };
  const updated = await router.dispatch(context, 'manager:settings-update', request('req-settings', { payload: { patch: { theme: 'light', opacity: 0.8 } } }));
  assert.deepEqual(updated.settings, { theme: 'light', globalLocked: true, opacity: 0.8 });
  assert.deepEqual(updated.snapshot.catalog.settings, updated.settings);
  const restarted = new AppService({ store });
  const restored = await restarted.start();
  assert.deepEqual(restored.catalog.settings, updated.settings);
});

test('routes edit begin/update/cancel and complete with session checks', async () => {
  const { service, router } = setup();
  await service.start();
  const context = { isManager: true, isMainFrame: true };
  const added = await router.dispatch(context, 'manager:component-add', request('req-add', { payload: { type: 'clock-date' } }));
  const instanceId = added.component.instanceId;
  const began = await router.dispatch(context, 'manager:edit-begin', request('req-begin', { instanceId, sessionId: 'session-2001' }));
  assert.equal(began.ok, true);
  const updated = await router.dispatch(context, 'manager:edit-update', request('req-update', { sessionId: 'session-2001', payload: { patch: { theme: { name: 'dark', opacity: 0.85 } } } }));
  assert.equal(updated.edit.theme.name, 'dark');
  const cancelled = await router.dispatch(context, 'manager:edit-cancel', request('req-cancel', { sessionId: 'session-2001' }));
  assert.equal(cancelled.ok, true);
  const stale = await router.dispatch(context, 'manager:edit-complete', request('req-stale', { sessionId: 'session-2001' }));
  assert.equal(stale.errorCode, 'STALE_SESSION');
});

test('completes the clock/date manager lifecycle and restores the saved editor state', async () => {
  const { store, service, router } = setup();
  await service.start();
  const context = { isManager: true, isMainFrame: true };

  const monitor = await router.dispatch(context, 'manager:component-add', request('req-monitor', { payload: { type: 'system-monitor' } }));
  const clock = await router.dispatch(context, 'manager:component-add', request('req-clock', { payload: { type: 'clock-date' } }));
  assert.equal(monitor.ok, true);
  assert.equal(clock.ok, true);
  const clockId = clock.component.instanceId;

  const hidden = await router.dispatch(context, 'manager:component-update', request('req-hide-monitor', {
    instanceId: monitor.component.instanceId,
    payload: { field: 'visible', value: false }
  }));
  assert.equal(hidden.component.visible, false);
  const shown = await router.dispatch(context, 'manager:component-update', request('req-show-monitor', {
    instanceId: monitor.component.instanceId,
    payload: { field: 'visible', value: true }
  }));
  assert.equal(shown.component.visible, true);

  const began = await router.dispatch(context, 'manager:edit-begin', request('req-clock-begin', {
    instanceId: clockId,
    sessionId: 'session-clock-2001'
  }));
  assert.equal(began.ok, true);
  const updated = await router.dispatch(context, 'manager:edit-update', request('req-clock-update', {
    sessionId: 'session-clock-2001',
    payload: {
      patch: {
        bounds: { x: 144, y: 88, width: 420, height: 176, unit: 'dip' },
        theme: { name: 'light', opacity: 0.78 },
        config: { format: '12h', showSeconds: false }
      }
    }
  }));
  assert.deepEqual(updated.edit.bounds, { x: 144, y: 88, width: 420, height: 176, unit: 'dip' });
  assert.deepEqual(updated.edit.theme, { name: 'light', opacity: 0.78 });
  assert.deepEqual(updated.edit.config, { format: '12h', showSeconds: false });
  const completed = await router.dispatch(context, 'manager:edit-complete', request('req-clock-complete', { sessionId: 'session-clock-2001' }));
  assert.equal(completed.ok, true);

  const restarted = new AppService({ store });
  const restored = await restarted.start();
  const restoredClock = restored.catalog.components.find(component => component.instanceId === clockId);
  assert.deepEqual(restoredClock.bounds, { x: 144, y: 88, width: 420, height: 176, unit: 'dip' });
  assert.deepEqual(restoredClock.theme, { name: 'light', opacity: 0.78 });
  assert.deepEqual(restoredClock.config, { format: '12h', showSeconds: false });
  assert.equal(restored.catalog.catalog.find(item => item.type === 'clock-date').available, false);

  await restarted.removeComponent(clockId);
  const afterRemoval = new AppService({ store });
  const finalSnapshot = await afterRemoval.start();
  assert.equal(finalSnapshot.catalog.components.some(component => component.instanceId === clockId), false);
});

test('does not expose raw service error text in IPC responses', async () => {
  const { service, router } = setup();
  await service.start();
  const context = { isManager: true, isMainFrame: true };
  const result = await router.dispatch(context, 'manager:component-add', request('req-invalid', { payload: { type: 'weather' } }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UNKNOWN_COMPONENT_TYPE');
  assert.equal(result.message, 'component type is not supported');
  assert.doesNotMatch(JSON.stringify(result), /G:\\|node_modules|stack/i);
});
