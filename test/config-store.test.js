const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/config-store');
const { createDefaultConfig, createDefaultComponent } = require('../src/config-contract');

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-config-'));
  return { root, store: new ConfigStore({ filePath: path.join(root, 'settings', 'config.json') }) };
}

test('saves with a temporary file and keeps the previous config as backup', async () => {
  const { store } = tempStore();
  const first = createDefaultConfig();
  await store.save(first, new Date('2026-09-06T00:00:00.000Z'));
  const second = { ...first, components: [createDefaultComponent('system-monitor', 'system-monitor-1')] };
  await store.save(second, new Date('2026-09-06T00:01:00.000Z'));
  const loaded = await store.load();
  assert.equal(loaded.source, 'primary');
  assert.equal(loaded.config.components.length, 1);
  const backup = JSON.parse(fs.readFileSync(store.backupPath, 'utf8'));
  assert.equal(backup.components.length, 0);
  assert.equal(fs.existsSync(store.tempPath), false);
});

test('falls back to a valid backup and then to an empty default', async () => {
  const { store } = tempStore();
  await store.save(createDefaultConfig(), new Date('2026-09-06T00:00:00.000Z'));
  await store.save({ ...createDefaultConfig(), components: [createDefaultComponent('system-monitor', 'system-monitor-1')] }, new Date('2026-09-06T00:01:00.000Z'));
  await fs.promises.writeFile(store.filePath, '{broken', 'utf8');
  const fromBackup = await store.load();
  assert.equal(fromBackup.source, 'backup');
  assert.equal(fromBackup.config.components.length, 0);
  await fs.promises.writeFile(store.backupPath, '{also broken', 'utf8');
  const fromDefault = await store.load();
  assert.equal(fromDefault.source, 'default');
  assert.equal(fromDefault.config.components.length, 0);
  assert.equal(fromDefault.errors.length, 2);
});

test('rejects invalid config before touching disk', async () => {
  const { store } = tempStore();
  await assert.rejects(() => store.save({ schemaVersion: 1 }, new Date()), error => error.code === 'CONFIG_INVALID');
  assert.equal(fs.existsSync(store.filePath), false);
});
