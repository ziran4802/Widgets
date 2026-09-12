const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexQuotaService, normalizeRateLimitsResponse, readAppServerQuota, resolveCodexExecutable } = require('../src/codex-quota-service');

test('finds the CCSwitch native Codex executable outside the PowerShell shim', () => {
  const executable = resolveCodexExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    readdirSync: () => [{ name: 'current', isDirectory: () => true }],
    existsSync: value => value.endsWith('current\\codex.exe')
  });
  assert.equal(executable, 'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\current\\codex.exe');
});

test('normalizes Codex primary and weekly rate-limit windows into remaining percentages', () => {
  const normalized = normalizeRateLimitsResponse({ result: { rateLimits: {
    primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 4102444800 },
    secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 4102444800 }
  } } }, new Date('2026-09-08T00:00:00.000Z'));
  assert.equal(normalized.phase, 'available');
  assert.equal(normalized.source, 'local-app-server');
  assert.deepEqual(normalized.fiveHour, { phase: 'available', remainingPercent: 62, usedPercent: 38, windowDurationMins: 300, resetsAt: 4102444800 });
  assert.equal(normalized.weekly.remainingPercent, 78);
});

test('rejects a rate-limit response without a usable quota window', () => {
  assert.throws(() => normalizeRateLimitsResponse({ result: { rateLimits: { credits: { balance: 'private' } } } }), error => error.code === 'CODEX_QUOTA_UNAVAILABLE');
});

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.stdin = { write: data => {
      const message = JSON.parse(data);
      if (message.id === 1) queueMicrotask(() => this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`));
      if (message.id === 2) queueMicrotask(() => this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } } })}\n`));
    } };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() { this.emit('exit', 0, null); }
}

test('speaks the local app-server JSON-RPC protocol without exposing raw output', async () => {
  const child = new FakeAppServer();
  const result = await readAppServerQuota({ spawnProcess: () => child, now: () => new Date('2026-09-08T00:00:00.000Z') });
  assert.equal(result.fiveHour.remainingPercent, 90);
  assert.equal(result.weekly, null);
});

test('fixture mode emits available data for isolated smoke without starting a child process', async () => {
  const updates = [];
  const service = new CodexQuotaService({
    fixture: { primary: { usedPercent: 38, windowDurationMins: 300 }, secondary: { usedPercent: 22, windowDurationMins: 10080 } },
    intervalMs: 1000,
    now: () => new Date('2026-09-08T00:00:00.000Z')
  });
  service.on('update', value => updates.push(value));
  const initial = await service.start();
  assert.equal(initial.phase, 'idle');
  await service.refresh();
  service.stop();
  assert.equal(updates.some(value => value.phase === 'available' && value.fiveHour.remainingPercent === 62 && value.weekly.remainingPercent === 78), true);
});

test('does not query on start and refreshes only when explicitly requested', async () => {
  let calls = 0;
  const service = new CodexQuotaService({
    spawnProcess: () => {
      calls += 1;
      const error = new Error('missing Codex');
      error.code = 'ENOENT';
      throw error;
    }
  });
  const initial = await service.start();
  assert.equal(initial.phase, 'idle');
  assert.equal(calls, 0);
  await service.refresh();
  assert.equal(calls, 1);
  service.stop();
});

test('loads a valid last quota snapshot from the local cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'widget-quota-cache-'));
  const cachePath = path.join(root, 'codex-quota-cache.json');
  try {
    await fs.writeFile(cachePath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-09-08T00:00:00.000Z',
      fiveHour: { usedPercent: 38, windowDurationMins: 300, resetsAt: 4102444800 },
      weekly: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 4102444800 }
    }));
    const service = new CodexQuotaService({ cachePath });
    const snapshot = await service.start();
    assert.equal(snapshot.phase, 'available');
    assert.equal(snapshot.source, 'local-cache');
    assert.equal(snapshot.cacheState, 'cached');
    assert.equal(snapshot.fiveHour.remainingPercent, 62);
    assert.equal(snapshot.weekly.remainingPercent, 78);
    service.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persists only the normalized quota snapshot after a successful refresh', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'widget-quota-cache-'));
  const cachePath = path.join(root, 'codex-quota-cache.json');
  try {
    const service = new CodexQuotaService({
      cachePath,
      fixture: { primary: { usedPercent: 38, windowDurationMins: 300 }, secondary: { usedPercent: 22, windowDurationMins: 10080 } },
      now: () => new Date('2026-09-08T00:00:00.000Z')
    });
    await service.start();
    await service.refresh();
    service.stop();
    const stored = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['fiveHour', 'schemaVersion', 'updatedAt', 'weekly']);
    assert.equal(stored.fiveHour.usedPercent, 38);
    assert.equal(stored.weekly.usedPercent, 22);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps the last available quota visible when a manual refresh fails', async () => {
  const service = new CodexQuotaService({ fixture: { primary: { usedPercent: 38, windowDurationMins: 300 } } });
  await service.start();
  const first = await service.refresh();
  service.fixture = undefined;
  service.spawnProcess = () => {
    const error = new Error('missing Codex');
    error.code = 'ENOENT';
    throw error;
  };
  const failed = await service.refresh();
  assert.equal(first.phase, 'available');
  assert.equal(failed.phase, 'stale');
  assert.equal(failed.cacheState, 'stale');
  assert.deepEqual(failed.fiveHour, first.fiveHour);
  assert.match(failed.message, /显示上次结果/);
  service.stop();
});

test('ignores malformed or incomplete quota caches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'widget-quota-cache-'));
  const cachePath = path.join(root, 'codex-quota-cache.json');
  try {
    await fs.writeFile(cachePath, '{"schemaVersion":1,"updatedAt":"bad"}');
    const service = new CodexQuotaService({ cachePath });
    const snapshot = await service.start();
    assert.equal(snapshot.phase, 'idle');
    service.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
