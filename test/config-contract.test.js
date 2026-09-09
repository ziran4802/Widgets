const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultConfig, createDefaultComponent, createDefaultTodoConfig, migrateDailyTodo, migrateLegacyCodexQuotaBounds, normalizeConfig, normalizeComponent } = require('../src/config-contract');

test('creates an empty versioned config and default component', () => {
  const now = new Date('2026-09-06T00:00:00.000Z');
  assert.deepEqual(createDefaultConfig(now), {
    schemaVersion: 1,
    layoutVersion: 1,
    updatedAt: '2026-09-06T00:00:00.000Z',
    settings: { theme: 'system', globalLocked: true, opacity: 0.92 },
    components: []
  });
  assert.equal(createDefaultComponent('system-monitor', 'system-monitor-1').type, 'system-monitor');
  const quota = createDefaultComponent('codex-quota', 'codex-quota-1');
  assert.deepEqual(quota.bounds, { x: 16, y: 336, width: 680, height: 300, unit: 'dip' });
});

test('upgrades only the legacy default Codex quota size and keeps the position', () => {
  const legacy = createDefaultComponent('codex-quota', 'codex-quota-1');
  legacy.bounds = { x: -120, y: 88, width: 520, height: 250, unit: 'dip' };
  const config = { ...createDefaultConfig(), components: [legacy] };
  const migrated = migrateLegacyCodexQuotaBounds(config);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.config.components[0].bounds, { x: -120, y: 88, width: 680, height: 300, unit: 'dip' });
  assert.deepEqual(config.components[0].bounds, { x: -120, y: 88, width: 520, height: 250, unit: 'dip' });

  const custom = { ...legacy, bounds: { x: 10, y: 20, width: 600, height: 280, unit: 'dip' } };
  const untouched = migrateLegacyCodexQuotaBounds({ ...config, components: [custom] });
  assert.equal(untouched.changed, false);
  assert.deepEqual(untouched.config.components[0].bounds, custom.bounds);
});

test('normalizes whitelisted config fields and rejects duplicates or invalid bounds', () => {
  const value = {
    schemaVersion: 1,
    layoutVersion: 1,
    updatedAt: '2026-09-06T00:00:00.000Z',
    settings: { theme: 'dark', globalLocked: false, ignored: true },
    ignored: 'drop me',
    components: [{
      ...createDefaultComponent('clock-date', 'clock-date-1'),
      bounds: { x: 1, y: 2, width: 300, height: 140, unit: 'dip' },
      ignored: true
    }]
  };
  const normalized = normalizeConfig(value);
  assert.equal(normalized.ignored, undefined);
  assert.equal(normalized.settings.ignored, undefined);
  assert.equal(normalized.settings.opacity, 0.92);
  assert.equal(normalized.components[0].bounds.width, 300);
  assert.throws(() => normalizeConfig({ ...value, components: [value.components[0], { ...value.components[0] }] }), /unique/);
  assert.throws(() => normalizeComponent({ ...value.components[0], bounds: { ...value.components[0].bounds, unit: 'physical' } }), /unit/);
});

test('normalizes a note as bounded plain text with explicit visual options', () => {
  const note = createDefaultComponent('note', 'note-1');
  assert.deepEqual(note.config, { title: '', text: '', size: 'standard', background: 'yellow' });
  const normalized = normalizeComponent({ ...note, config: { title: '今天', text: '只保存纯文本', size: 'large', background: 'blue', ignored: '<b>html</b>' } });
  assert.deepEqual(normalized.config, { title: '今天', text: '只保存纯文本', size: 'large', background: 'blue' });
  assert.equal(normalizeComponent({ ...note, config: { ...note.config, text: '<script>alert(1)</script>' } }).config.text, '<script>alert(1)</script>');
  assert.throws(() => normalizeComponent({ ...note, config: { ...note.config, size: 'huge' } }), /size/);
});

test('normalizes daily todo items and strips unsupported fields', () => {
  const todo = createDefaultComponent('daily-todo', 'daily-todo-1');
  assert.deepEqual(todo.config, createDefaultTodoConfig());
  const normalized = normalizeComponent({
    ...todo,
    config: {
      dateKey: '2026-09-09',
      items: [{ id: 'todo-1', title: '完成迁移', completed: true, ignored: 'drop me' }]
    }
  });
  assert.deepEqual(normalized.config, { dateKey: '2026-09-09', items: [{ id: 'todo-1', title: '完成迁移', completed: true }] });
  assert.throws(() => normalizeComponent({ ...todo, config: { dateKey: '2026-09-09', items: [{ id: 'todo-1', title: '重复', completed: false }, { id: 'todo-1', title: '重复', completed: false }] } }), /unique/);
  assert.throws(() => normalizeComponent({ ...todo, config: { dateKey: '2026-09-09', items: [{ id: 'todo-1', title: '', completed: false }] } }), /non-empty/);
  assert.throws(() => normalizeComponent({ ...todo, config: { dateKey: '2026-02-30', items: [] } }), /valid ISO local date/);
});

test('resets stale daily todo data only when the local day changes', () => {
  const todo = createDefaultComponent('daily-todo', 'daily-todo-1');
  const config = { ...createDefaultConfig(), components: [{ ...todo, config: { dateKey: '2026-09-08', items: [{ id: 'todo-1', title: '昨天', completed: false }] } }] };
  const migrated = migrateDailyTodo(config, new Date('2026-09-09T01:00:00'));
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.config.components[0].config, { dateKey: '2026-09-09', items: [] });
  assert.equal(migrateDailyTodo(migrated.config, new Date('2026-09-09T18:00:00')).changed, false);
});
