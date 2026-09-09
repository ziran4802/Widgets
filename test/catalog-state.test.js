const test = require('node:test');
const assert = require('node:assert/strict');
const { CatalogState, CatalogStateError } = require('../src/catalog-state');

test('catalog exposes available types and supports add, hide, remove and re-add', () => {
  const catalog = new CatalogState();
  assert.equal(catalog.getSnapshot().catalog.every(item => item.available), true);
  const first = catalog.addComponent('system-monitor');
  assert.equal(first.instanceId, 'system-monitor-1');
  assert.equal(catalog.getSnapshot().catalog.find(item => item.type === 'system-monitor').available, false);
  catalog.setVisible(first.instanceId, false);
  assert.equal(catalog.getSnapshot().components[0].lifecycle, 'hidden');
  catalog.removeComponent(first.instanceId);
  const second = catalog.addComponent('system-monitor');
  assert.equal(second.instanceId, 'system-monitor-2');
});

test('v1 prevents duplicate types and invalid lifecycle operations', () => {
  const catalog = new CatalogState();
  catalog.addComponent('clock-date');
  assert.throws(() => catalog.addComponent('clock-date'), error => error instanceof CatalogStateError && error.code === 'COMPONENT_ALREADY_EXISTS');
  assert.throws(() => catalog.addComponent('weather'), error => error.code === 'UNKNOWN_COMPONENT_TYPE');
  assert.throws(() => catalog.beginEdit('clock-date-1', 'short'), error => error.code === 'INVALID_SESSION');
});

test('exposes Codex quota as a single available component type', () => {
  const catalog = new CatalogState();
  const item = catalog.getSnapshot().catalog.find(entry => entry.type === 'codex-quota');
  assert.deepEqual(item, { type: 'codex-quota', displayName: 'Codex 额度', available: true, instanceId: undefined, visible: undefined, lifecycle: 'available' });
  const added = catalog.addComponent('codex-quota');
  assert.equal(added.instanceId, 'codex-quota-1');
  assert.throws(() => catalog.addComponent('codex-quota'), error => error.code === 'COMPONENT_ALREADY_EXISTS');
});

test('edit cancel keeps committed config while complete commits a working copy', () => {
  const catalog = new CatalogState();
  const component = catalog.addComponent('system-monitor');
  const before = catalog.getConfig();
  catalog.beginEdit(component.instanceId, 'session-0001');
  catalog.updateEdit('session-0001', { bounds: { x: 100, y: 120, width: 420, height: 180, unit: 'dip' } });
  assert.deepEqual(catalog.getConfig(), before);
  catalog.cancelEdit('session-0001');
  assert.deepEqual(catalog.getConfig(), before);
  catalog.beginEdit(component.instanceId, 'session-0002');
  catalog.updateEdit('session-0002', { theme: { name: 'dark', opacity: 0.8 } });
  const committed = catalog.completeEdit('session-0002');
  assert.equal(committed.components[0].theme.name, 'dark');
  assert.equal(catalog.getSnapshot().activeEdit, null);
});

test('moves a component by position without changing its size', () => {
  const catalog = new CatalogState();
  const component = catalog.addComponent('system-monitor');
  const moved = catalog.setPosition(component.instanceId, { x: -120, y: 240 });
  assert.deepEqual(moved.bounds, { x: -120, y: 240, width: 520, height: 190, unit: 'dip' });
  assert.deepEqual(catalog.getSnapshot().components[0].bounds, moved.bounds);
});

test('keeps a live drag position when an edit transaction is open', () => {
  const catalog = new CatalogState();
  const component = catalog.addComponent('system-monitor');
  catalog.beginEdit(component.instanceId, 'session-0004');
  catalog.updateEdit('session-0004', { bounds: { x: 80, y: 90, width: 420, height: 180, unit: 'dip' } });

  const moved = catalog.setPosition(component.instanceId, { x: 240, y: -80 });
  assert.deepEqual(moved.bounds, { x: 240, y: -80, width: 420, height: 180, unit: 'dip' });
  const completed = catalog.completeEdit('session-0004');
  assert.deepEqual(completed.components[0].bounds, { x: 240, y: -80, width: 420, height: 180, unit: 'dip' });
});

test('stale edit sessions cannot mutate or commit state', () => {
  const catalog = new CatalogState();
  const component = catalog.addComponent('system-monitor');
  catalog.beginEdit(component.instanceId, 'session-0003');
  assert.throws(() => catalog.updateEdit('session-old', {}), error => error.code === 'STALE_SESSION');
  assert.throws(() => catalog.completeEdit('session-old'), error => error.code === 'STALE_SESSION');
  assert.throws(() => catalog.removeComponent(component.instanceId), error => error.code === 'EDIT_IN_PROGRESS');
});

test('persists note content independently and keeps it when layout editing is cancelled', () => {
  const catalog = new CatalogState();
  const note = catalog.addComponent('note');
  catalog.beginEdit(note.instanceId, 'session-note-1');
  catalog.updateEdit('session-note-1', { bounds: { x: 220, y: 240, width: 360, height: 300, unit: 'dip' } });
  const saved = catalog.setNoteContent(note.instanceId, { title: '今天', text: '布局取消也不能丢' });
  assert.deepEqual(saved.config, { title: '今天', text: '布局取消也不能丢', size: 'standard', background: 'yellow' });
  catalog.cancelEdit('session-note-1');
  const restored = catalog.getSnapshot().components[0];
  assert.equal(restored.config.text, '布局取消也不能丢');
  assert.equal(restored.config.title, '今天');
  assert.deepEqual(restored.bounds, { x: 320, y: 16, width: 300, height: 260, unit: 'dip' });
});

test('note layout updates do not overwrite content saved during the same edit session', () => {
  const catalog = new CatalogState();
  const note = catalog.addComponent('note');
  catalog.beginEdit(note.instanceId, 'session-note-2');
  catalog.setNoteContent(note.instanceId, { title: '实时标题', text: '实时正文' });
  catalog.updateEdit('session-note-2', { config: { size: 'large', background: 'blue' } });
  const completed = catalog.completeEdit('session-note-2');
  assert.deepEqual(completed.components[0].config, { title: '实时标题', text: '实时正文', size: 'large', background: 'blue' });
});

test('persists daily todo items independently and keeps them when layout editing is cancelled', () => {
  const catalog = new CatalogState(undefined, { now: () => new Date('2026-09-09T10:00:00') });
  const todo = catalog.addComponent('daily-todo');
  catalog.beginEdit(todo.instanceId, 'session-todo-1');
  catalog.updateEdit('session-todo-1', { bounds: { x: 220, y: 240, width: 420, height: 360, unit: 'dip' } });
  const saved = catalog.setTodoItems(todo.instanceId, {
    dateKey: '2026-09-09',
    items: [{ id: 'todo-1', title: '完成迁移', completed: true }]
  });
  assert.deepEqual(saved.config.items, [{ id: 'todo-1', title: '完成迁移', completed: true }]);
  catalog.cancelEdit('session-todo-1');
  const restored = catalog.getSnapshot().components[0];
  assert.deepEqual(restored.config.items, [{ id: 'todo-1', title: '完成迁移', completed: true }]);
  assert.deepEqual(restored.bounds, { x: 16, y: 336, width: 360, height: 420, unit: 'dip' });
});

test('persists global appearance settings without changing component overrides', () => {
  const catalog = new CatalogState();
  const clock = catalog.addComponent('clock-date');
  const settings = catalog.setSettings({ theme: 'light', opacity: 0.8 });
  assert.deepEqual(settings, { theme: 'light', globalLocked: true, opacity: 0.8 });
  assert.equal(catalog.getSnapshot().components[0].theme.name, 'system');
  assert.throws(() => catalog.setSettings({ unsupported: true }), error => error.code === 'INVALID_VALUE');
  assert.equal(clock.type, 'clock-date');
});
