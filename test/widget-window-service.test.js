const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WidgetWindowService, buildWidgetWindowOptions, resolveComponent } = require('../src/widget-window-service');

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new EventEmitter();
    this.sent = [];
    this.destroyed = false;
    this.shown = false;
    this.hidden = false;
    this.movable = options.movable;
    this.ignoreMouseEvents = undefined;
    this.messageHooks = new Map();
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.position = [options.x, options.y];
    this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
  }

  loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  setBounds(bounds) { this.bounds = bounds; }
  setMovable(movable) { this.movable = movable; }
  setIgnoreMouseEvents(ignore, options) { this.ignoreMouseEvents = { ignore, options }; }
  getPosition() { return this.position.slice(); }
  show() { this.shown = true; }
  hide() { this.hidden = true; }
  close() { this.destroyed = true; this.emit('closed'); }
  hookWindowMessage(message, callback) { this.messageHooks.set(message, callback); }
  unhookWindowMessage(message) { this.messageHooks.delete(message); }
  emitWindowMessage(message) { this.messageHooks.get(message)?.(0, 0); }
}

function snapshot(components) {
  return { catalog: { components } };
}

function component(overrides = {}) {
  return {
    instanceId: 'system-monitor-1',
    type: 'system-monitor',
    displayName: '系统监测',
    visible: true,
    bounds: { x: 12.4, y: 20.6, width: 360, height: 160 },
    ...overrides
  };
}

test('builds a transparent, non-taskbar widget window from DIP bounds', () => {
  const options = buildWidgetWindowOptions(component(), 'widget-preload.js');
  assert.deepEqual({ x: options.x, y: options.y, width: options.width, height: options.height }, { x: 12, y: 21, width: 360, height: 160 });
  assert.equal(options.transparent, true);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.alwaysOnTop, false);
  assert.equal(options.movable, false);
  assert.equal(options.focusable, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
});

test('resolves system component theme and default opacity from global appearance settings', () => {
  const base = component({ theme: { name: 'system', opacity: 0.92 } });
  assert.deepEqual(resolveComponent(base, { theme: 'light', opacity: 0.78 }).theme, { name: 'light', opacity: 0.78 });
  assert.deepEqual(resolveComponent({ ...base, theme: { name: 'dark', opacity: 0.8 } }, { theme: 'light', opacity: 0.78 }).theme, { name: 'dark', opacity: 0.8 });
});

test('creates, updates, hides, publishes metrics to and removes widget windows', () => {
  const created = [];
  const service = new WidgetWindowService({
    createWindow: options => { const window = new FakeWindow(options); created.push(window); return window; },
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html'
  });
  const initial = component();
  service.sync(snapshot([initial]));
  assert.equal(created.length, 1);
  const window = created[0];
  assert.equal(window.movable, false);
  assert.equal(service.setEditMode(initial.instanceId, true), true);
  assert.equal(window.movable, true);
  service.setEditMode(initial.instanceId, false);
  assert.equal(window.movable, false);
  assert.equal(window.loadedFile, 'widget.html');
  window.webContents.emit('did-finish-load');
  assert.equal(window.shown, true);
  assert.equal(window.sent[0].channel, 'widget:state');

  service.publishMetrics({ phase: 'ready', cpu: { usagePercent: 12.5 }, memory: { usagePercent: 40 } });
  assert.equal(window.sent.at(-1).channel, 'widget:metrics');
  service.publishCodexQuota({ phase: 'available', fiveHour: { remainingPercent: 62 }, weekly: { remainingPercent: 78 } });
  assert.equal(window.sent.at(-1).channel, 'widget:codex-quota');
  service.sync(snapshot([component({ bounds: { x: 100, y: 120, width: 400, height: 180 } })]));
  assert.deepEqual(window.bounds, { x: 100, y: 120, width: 400, height: 180 });
  service.sync(snapshot([component({ visible: false })]));
  assert.equal(window.hidden, true);
  service.sync(snapshot([]));
  assert.equal(window.destroyed, true);
});

test('temporarily hides only the currently visible components without changing config state', () => {
  const created = [];
  const service = new WidgetWindowService({
    createWindow: options => { const window = new FakeWindow(options); created.push(window); return window; },
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html'
  });
  const visible = component();
  const hidden = component({ instanceId: 'clock-date-1', visible: false });
  service.sync(snapshot([visible, hidden]));
  const visibleWindow = created[0];
  visibleWindow.webContents.emit('did-finish-load');
  service.setTemporaryHidden(true, snapshot([visible, hidden]));
  assert.equal(service.isTemporarilyHidden(), true);
  assert.equal(visibleWindow.hidden, true);
  service.setTemporaryHidden(false, snapshot([visible, hidden]));
  assert.equal(service.isTemporarilyHidden(), false);
  assert.equal(visibleWindow.shown, true);
});

test('flushes a loaded note before shutdown and accepts the renderer result', async () => {
  const note = component({
    instanceId: 'note-1',
    type: 'note',
    displayName: '便签',
    bounds: { x: 16, y: 16, width: 300, height: 260, unit: 'dip' },
    config: { title: '', text: '待保存', size: 'standard', background: 'yellow' }
  });
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html'
  });
  service.sync(snapshot([note]));
  const record = [...service.windows.values()][0];
  record.window.webContents.emit('did-finish-load');
  const pending = service.requestNoteFlush(1000);
  const request = record.window.sent.at(-1);
  assert.equal(request.channel, 'widget:flush-note');
  assert.equal(service.completeNoteFlush(record.window.webContents, request.payload.requestId, { ok: true }), true);
  assert.deepEqual(await pending, [{ ok: true }]);
  assert.equal(service.updateComponentRecord(note.instanceId, { ...note, config: { ...note.config, text: '已保存' } }), true);
  assert.equal(record.component.config.text, '已保存');
});

test('persists a manually moved window and reverts when persistence fails', async () => {
  const moves = [];
  const created = [];
  const service = new WidgetWindowService({
    createWindow: options => { const window = new FakeWindow(options); created.push(window); return window; },
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    onMove: async (instanceId, position) => { moves.push({ instanceId, position }); return component({ bounds: { x: position.x, y: position.y, width: 360, height: 160 } }); }
  });
  service.sync(snapshot([component()]));
  const window = created[0];
  window.webContents.emit('did-finish-load');
  window.position = [240, -80];
  window.bounds = { ...window.bounds, x: 240, y: -80 };
  window.emit('moved');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(moves, []);
  service.setEditMode('system-monitor-1', true);
  window.emit('moved');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(moves, [{ instanceId: 'system-monitor-1', position: { x: 240, y: -80 } }]);
  assert.deepEqual(window.bounds, { x: 240, y: -80, width: 360, height: 160 });

  const failing = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    onMove: async () => { throw new Error('write failed'); }
  });
  failing.sync(snapshot([component()]));
  const failingWindow = [...failing.windows.values()][0].window;
  failing.setEditMode('system-monitor-1', true);
  failingWindow.position = [300, 300];
  failingWindow.emit('moved');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failingWindow.bounds, { x: 12, y: 21, width: 360, height: 160 });
});

test('ignores a late move result after editing is cancelled', async () => {
  let resolveMove;
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    onMove: () => new Promise(resolve => { resolveMove = resolve; })
  });
  const initial = component();
  service.sync(snapshot([initial]));
  const record = [...service.windows.values()][0];
  service.setEditMode(initial.instanceId, true);
  record.window.position = [240, -80];
  record.window.emit('moved');
  service.setEditMode(initial.instanceId, false);
  service.sync(snapshot([initial]));
  resolveMove(component({ bounds: { x: 240, y: -80, width: 360, height: 160 } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(record.component.bounds, initial.bounds);
  assert.deepEqual(record.window.bounds, { x: 12, y: 21, width: 360, height: 160 });
});

test('recovers unexpected window closure but suppresses normal teardown notifications', () => {
  const closed = [];
  const createService = () => new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    onWindowClosed: instanceId => closed.push(instanceId)
  });

  const recovered = createService();
  recovered.sync(snapshot([component()]));
  [...recovered.windows.values()][0].window.close();
  assert.deepEqual(closed, ['system-monitor-1']);

  closed.length = 0;
  const removed = createService();
  removed.sync(snapshot([component()]));
  removed.sync(snapshot([]));
  assert.deepEqual(closed, []);

  const quitting = createService();
  quitting.sync(snapshot([component()]));
  quitting.closeAll();
  assert.deepEqual(closed, []);
});

test('turns a renderer process exit into the same recoverable closure path', () => {
  const reasons = [];
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    onWindowClosed: (_instanceId, _component, reason) => reasons.push(reason)
  });
  service.sync(snapshot([component()]));
  const record = [...service.windows.values()][0];
  record.window.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(reasons, ['render process gone: crashed']);
  assert.equal(service.windows.size, 0);
});

test('handles Electron renderer process exit from webContents', () => {
  const reasons = [];
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    onWindowClosed: (_instanceId, _component, reason) => reasons.push(reason)
  });
  service.sync(snapshot([component()]));
  const record = [...service.windows.values()][0];
  record.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  assert.deepEqual(reasons, ['render process gone: oom']);
  assert.equal(service.windows.size, 0);
});

test('coordinates a registered window with HostService when WorkerW mode is enabled', async () => {
  const calls = [];
  const hostService = {
    adapter: { registerWindow(instanceId, window) { calls.push(['register', instanceId, window]); } },
    async create(component) { calls.push(['create', component.instanceId]); return { phase: 'created' }; },
    async attach(instanceId, display) { calls.push(['attach', instanceId, display]); return { phase: 'ready', instanceId, mode: 'locked' }; },
    async setInputMode(instanceId, mode) { calls.push(['input', instanceId, mode]); return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry(instanceId, bounds) { calls.push(['geometry', instanceId, bounds.x]); return { phase: 'editing', instanceId, mode: 'editing' }; },
    async destroy(instanceId) { calls.push(['destroy', instanceId]); return { ok: true, instanceId }; }
  };
  const created = [];
  const service = new WidgetWindowService({
    createWindow: options => { const window = new FakeWindow(options); created.push(window); return window; },
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService,
    hostTargetDisplay: component => component.displayId || 'primary'
  });
  service.sync(snapshot([component()]));
  const window = created[0];
  service.setEditMode('system-monitor-1', true);
  await new Promise(resolve => setImmediate(resolve));
  window.webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.shown, true);
  assert.deepEqual(window.ignoreMouseEvents, { ignore: false, options: { forward: false } });
  assert.deepEqual(calls.map(call => call[0]), ['register', 'create', 'attach', 'input']);
  assert.equal(calls.at(-1)[2], 'editing');

  service.setEditMode('system-monitor-1', false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(window.ignoreMouseEvents, { ignore: true, options: { forward: true } });

  service.sync(snapshot([component({ bounds: { x: 80, y: 90, width: 360, height: 160 } })]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['geometry', 'system-monitor-1', 80]);
  service.sync(snapshot([]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.destroyed, true);
  assert.equal(calls.some(call => call[0] === 'destroy'), true);
});

test('keeps the daily todo widget interactive in a regular floating window', async () => {
  const calls = [];
  const hostService = {
    adapter: { registerWindow() {} },
    async create(component) { calls.push(['create', component.instanceId]); return { phase: 'created' }; },
    async attach(instanceId) { calls.push(['attach', instanceId]); return { phase: 'ready', instanceId, mode: 'locked' }; },
    async setInputMode(instanceId, mode) { calls.push(['input', instanceId, mode]); return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry() { return { phase: 'ready' }; },
    async destroy() { return { ok: true }; }
  };
  const created = [];
  const service = new WidgetWindowService({
    createWindow: options => { const window = new FakeWindow(options); created.push(window); return window; },
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService
  });
  const todo = component({ instanceId: 'daily-todo-1', type: 'daily-todo', displayName: '每日待办' });
  service.sync(snapshot([todo]));
  await new Promise(resolve => setImmediate(resolve));
  const window = created[0];
  window.webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));
  const record = [...service.windows.values()][0];
  assert.equal(record.hostMode, 'floating');
  assert.equal(record.hostReady, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(window.ignoreMouseEvents, { ignore: false, options: { forward: false } });
});

test('toggles daily todo desktop interaction without changing its component config', async () => {
  const calls = [];
  const hostService = {
    adapter: { registerWindow() {} },
    async create(component) { calls.push(['create', component.instanceId]); return { phase: 'created' }; },
    async attach(instanceId) { calls.push(['attach', instanceId]); return { phase: 'ready', instanceId, mode: 'locked' }; },
    async setInputMode(instanceId, mode) { calls.push(['input', instanceId, mode]); return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry() { return { phase: 'ready' }; },
    async destroy() { return { ok: true }; }
  };
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService
  });
  const todo = component({ instanceId: 'daily-todo-1', type: 'daily-todo', displayName: '每日待办', locked: true });
  service.sync(snapshot([todo]));
  const record = [...service.windows.values()][0];
  await record.hostTask;
  record.window.webContents.emit('did-finish-load');

  const locked = await service.setTodoInteraction(todo.instanceId, false);
  assert.deepEqual(locked, { ok: true, interactive: false });
  await record.hostTask;
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: true, options: { forward: true } });
  assert.equal(calls.length, 0);
  assert.equal(record.component.locked, true);
  assert.equal(record.component.type, 'daily-todo');
  assert.equal(record.window.sent.at(-1).payload.interactive, false);

  service.setEditMode(todo.instanceId, true);
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: false, options: { forward: false } });
  service.setEditMode(todo.instanceId, false);
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: true, options: { forward: true } });

  const unlocked = await service.setTodoInteraction(todo.instanceId, true);
  assert.deepEqual(unlocked, { ok: true, interactive: true });
  await record.hostTask;
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: false, options: { forward: false } });
  assert.equal(calls.length, 0);
  assert.equal(record.window.sent.at(-1).payload.interactive, true);
});

test('does not keep a WorkerW widget visible as interactive when native input mode fails', async () => {
  const hostService = {
    adapter: { registerWindow() {} },
    async create(component) { return { phase: 'created', instanceId: component.instanceId }; },
    async attach(instanceId) { return { phase: 'ready', instanceId }; },
    async setInputMode(instanceId, mode) { return { phase: 'ready', instanceId, mode, lastResult: { success: false, errors: ['style refresh failed'] } }; },
    async setGeometry() { return { phase: 'ready' }; },
    async destroy() { return { ok: true }; }
  };
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService
  });
  service.sync(snapshot([component()]));
  const record = [...service.windows.values()][0];
  await record.hostTask;
  assert.equal(record.hostReady, false);
  assert.equal(record.hostPhase, 'unavailable');
  assert.equal(record.window.hidden, true);
});

test('moves a WorkerW widget from native mouse messages and captures the pointer', async () => {
  const calls = [];
  const hostService = {
    adapter: { registerWindow() {} },
    async create(component) { calls.push(['create', component.instanceId]); return { phase: 'created' }; },
    async attach(instanceId) { calls.push(['attach', instanceId]); return { phase: 'ready', instanceId, mode: 'locked' }; },
    async setInputMode(instanceId, mode) { calls.push(['input', instanceId, mode]); return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry(instanceId, nextBounds) { calls.push(['geometry', instanceId, nextBounds.x, nextBounds.y]); return { phase: 'editing', instanceId, mode: 'editing' }; },
    async capturePointer(instanceId) { calls.push(['capture', instanceId]); return { success: true }; },
    async releasePointer(instanceId) { calls.push(['release', instanceId]); return { success: true }; }
  };
  const cursor = { x: 20, y: 30 };
  const moved = [];
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService,
    getCursorPoint: () => cursor,
    onMove: async (instanceId, position) => { moved.push({ instanceId, position }); return component({ bounds: { x: position.x, y: position.y, width: 360, height: 160, unit: 'dip' } }); }
  });
  service.sync(snapshot([component()]));
  const record = [...service.windows.values()][0];
  await new Promise(resolve => setImmediate(resolve));
  service.setEditMode('system-monitor-1', true);
  record.window.webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));

  record.window.emitWindowMessage(0x0201);
  cursor.x = 80;
  cursor.y = 100;
  record.window.emitWindowMessage(0x0200);
  record.window.emitWindowMessage(0x0202);
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(moved, [{ instanceId: 'system-monitor-1', position: { x: 72.4, y: 90.6 } }]);
  assert.equal(calls.some(call => call[0] === 'capture' && call[1] === 'system-monitor-1'), true);
  assert.equal(calls.some(call => call[0] === 'release' && call[1] === 'system-monitor-1'), true);
  assert.equal(record.nativeDrag, false);
});

test('moves an editing widget through the controlled pointer drag path', async () => {
  const calls = [];
  const hostService = {
    adapter: { registerWindow(instanceId) { calls.push(['register', instanceId]); } },
    async create(component) { calls.push(['create', component.instanceId]); return { phase: 'created' }; },
    async attach(instanceId) { calls.push(['attach', instanceId]); return { phase: 'ready', instanceId, mode: 'locked' }; },
    async setInputMode(instanceId, mode) { calls.push(['input', instanceId, mode]); return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry(instanceId, nextBounds) { calls.push(['geometry', instanceId, nextBounds.x, nextBounds.y]); return { phase: 'editing', instanceId, mode: 'editing' }; },
    async destroy(instanceId) { calls.push(['destroy', instanceId]); return { ok: true, instanceId }; }
  };
  const moved = [];
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService,
    onMove: async (instanceId, position) => { moved.push({ instanceId, position }); return component({ bounds: { x: position.x, y: position.y, width: 360, height: 160 } }); }
  });
  service.sync(snapshot([component()]));
  const record = [...service.windows.values()][0];
  await new Promise(resolve => setImmediate(resolve));
  service.setEditMode('system-monitor-1', true);
  const started = await service.dispatchDrag(record.window.webContents, 'start', { pointerId: 1, x: 10, y: 20 });
  const updated = await service.dispatchDrag(record.window.webContents, 'update', { pointerId: 1, x: 50, y: 65 });
  const ended = await service.dispatchDrag(record.window.webContents, 'end', { pointerId: 1, x: 50, y: 65 });
  assert.equal(started.ok, true);
  assert.deepEqual(updated.bounds, { x: 52.4, y: 65.6, width: 360, height: 160, unit: 'dip' });
  assert.equal(ended.ok, true);
  assert.deepEqual(moved, [{ instanceId: 'system-monitor-1', position: { x: 52.4, y: 65.6 } }]);
  assert.equal(calls.some(call => call[0] === 'geometry' && call[2] === 52.4 && call[3] === 65.6), true);
  service.setEditMode('system-monitor-1', false);
  const locked = await service.dispatchDrag(record.window.webContents, 'start', { pointerId: 2, x: 0, y: 0 });
  assert.equal(locked.errorCode, 'DRAG_NOT_ALLOWED');
});

test('translates a renderer drag request through the current screen cursor', async () => {
  const hostService = {
    adapter: { registerWindow() {} },
    async create(component) { return { phase: 'created', instanceId: component.instanceId }; },
    async attach(instanceId) { return { phase: 'ready', instanceId, mode: 'locked' }; },
    async setInputMode(instanceId, mode) { return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry(instanceId, bounds) { return { phase: 'editing', instanceId, mode: 'editing', bounds }; }
  };
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService,
    getCursorPoint: () => ({ x: 44, y: 55 })
  });
  service.sync(snapshot([component()]));
  await new Promise(resolve => setImmediate(resolve));
  service.setEditMode('system-monitor-1', true);
  const record = [...service.windows.values()][0];
  const started = await service.dispatchDragFromCursor(record.window.webContents, 'start', 7);
  assert.deepEqual(started.bounds, { x: 12.4, y: 20.6, width: 360, height: 160 });
  const updated = await service.dispatchDragFromCursor(record.window.webContents, 'update', 7);
  assert.equal(updated.bounds.width, 360);
  assert.equal(updated.bounds.height, 160);
  assert.ok(Math.abs(updated.bounds.x - 12.4) < 1e-9);
  assert.ok(Math.abs(updated.bounds.y - 20.6) < 1e-9);
  assert.equal(updated.bounds.unit, 'dip');
});

test('switches a WorkerW widget to floating while editing and reattaches after layout ends', async () => {
  const calls = [];
  const hostService = {
    adapter: { registerWindow() {} },
    async create(component) { calls.push(['create', component.instanceId]); return { phase: 'created' }; },
    async attach(instanceId) { calls.push(['attach', instanceId]); return { phase: 'ready', instanceId, mode: 'locked' }; },
    async detach(instanceId) { calls.push(['detach', instanceId]); return { phase: 'detached', instanceId }; },
    async setInputMode(instanceId, mode) { calls.push(['input', instanceId, mode]); return { phase: mode === 'editing' ? 'editing' : 'ready', instanceId, mode }; },
    async setGeometry(instanceId, bounds) { calls.push(['geometry', instanceId, bounds.x]); return { phase: 'editing', instanceId, mode: 'editing' }; }
  };
  const moved = [];
  const cursor = { x: 20, y: 30 };
  const service = new WidgetWindowService({
    createWindow: options => new FakeWindow(options),
    preloadPath: 'widget-preload.js',
    pagePath: 'widget.html',
    hostService,
    getCursorPoint: () => cursor,
    onMove: async (instanceId, position) => {
      moved.push({ instanceId, position });
      return component({ bounds: { x: position.x, y: position.y, width: 360, height: 160, unit: 'dip' } });
    }
  });
  service.sync(snapshot([component()]));
  const record = [...service.windows.values()][0];
  await record.hostTask;
  record.window.webContents.emit('did-finish-load');
  assert.equal(record.hostMode, 'desktop');
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: true, options: { forward: true } });

  record.window.shown = false;
  service.setEditMode('system-monitor-1', true);
  await record.hostTask;
  assert.equal(record.hostMode, 'floating');
  assert.equal(record.window.shown, true);
  assert.equal(record.window.movable, true);
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: false, options: { forward: false } });
  assert.equal(record.window.sent.at(-1).payload.dragMode, 'electron-native');

  const started = await service.dispatchDragFromCursor(record.window.webContents, 'start', 4);
  cursor.x = 70;
  cursor.y = 90;
  const updated = await service.dispatchDragFromCursor(record.window.webContents, 'update', 4);
  const ended = await service.dispatchDragFromCursor(record.window.webContents, 'end', 4);
  assert.equal(started.ok, true);
  assert.equal(updated.ok, true);
  assert.equal(ended.ok, true);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].instanceId, 'system-monitor-1');
  assert.ok(Math.abs(moved[0].position.x - 62.4) < 1e-9);
  assert.ok(Math.abs(moved[0].position.y - 80.6) < 1e-9);
  assert.equal(calls.some(call => call[0] === 'geometry'), false);

  service.setEditMode('system-monitor-1', false);
  await record.hostTask;
  assert.equal(record.hostMode, 'desktop');
  assert.equal(record.window.movable, false);
  assert.deepEqual(record.window.ignoreMouseEvents, { ignore: true, options: { forward: true } });
  assert.deepEqual(calls.filter(call => call[0] === 'detach' || call[0] === 'attach' || call[0] === 'input').map(call => call[0]), ['attach', 'input', 'detach', 'attach', 'input']);
});
