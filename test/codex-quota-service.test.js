const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
  service.start();
  await new Promise(resolve => setImmediate(resolve));
  service.stop();
  assert.equal(updates.some(value => value.phase === 'available' && value.fiveHour.remainingPercent === 62 && value.weekly.remainingPercent === 78), true);
});
