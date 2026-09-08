const test = require('node:test');
const assert = require('node:assert/strict');
const { MetricsService, cpuUsagePercent, readMemory } = require('../src/metrics-service');

function unavailableResources() {
  return {
    gpu: { phase: 'unavailable', reason: 'test gpu unavailable' },
    network: { phase: 'unavailable', reason: 'test network unavailable' }
  };
}

test('calculates aggregate CPU usage from two samples', () => {
  const before = [{ user: 20, nice: 0, sys: 10, idle: 70, irq: 0 }];
  const after = [{ user: 45, nice: 0, sys: 15, idle: 80, irq: 0 }];
  assert.equal(cpuUsagePercent(before, after), 75);
});

test('normalizes memory samples and clamps free memory', () => {
  assert.deepEqual(readMemory(() => ({ total: 1000, free: 1200 })), {
    totalBytes: 1000,
    usedBytes: 0,
    freeBytes: 1000,
    usagePercent: 0
  });
});

test('publishes ready samples and hides reader failures behind a stable error', () => {
  const samples = [
    [{ user: 20, nice: 0, sys: 10, idle: 70, irq: 0 }],
    [{ user: 45, nice: 0, sys: 15, idle: 80, irq: 0 }]
  ];
  const updates = [];
  const service = new MetricsService({
    intervalMs: 250,
    readCpu: () => samples.shift(),
    readMemory: () => ({ totalBytes: 1000, usedBytes: 400, freeBytes: 600, usagePercent: 40 }),
    readResources: unavailableResources,
    now: () => new Date('2026-09-06T00:00:00.000Z')
  });
  service.on('update', snapshot => updates.push(snapshot));
  service.start();
  assert.equal(service.snapshot().phase, 'ready');
  service.sample();
  assert.equal(service.snapshot().cpu.usagePercent, 75);
  assert.equal(updates.length, 2);
  service.stop();

  const broken = new MetricsService({ intervalMs: 250, readCpu: () => { throw new Error('internal path'); }, readResources: unavailableResources });
  const snapshot = broken.start();
  assert.equal(snapshot.phase, 'degraded');
  assert.deepEqual(snapshot.error, { code: 'METRICS_READ_FAILED', message: '系统指标暂时不可用' });
  broken.stop();
});

test('resets the CPU baseline when stopped before a later restart', () => {
  const samples = [
    [{ user: 100, system: 20, idle: 80 }],
    [{ user: 130, system: 30, idle: 90 }],
    [{ user: 160, system: 40, idle: 100 }]
  ];
  const service = new MetricsService({
    intervalMs: 250,
    readCpu: () => samples.shift(),
    readMemory: () => ({ total: 100, free: 40 }),
    readResources: unavailableResources,
    now: () => new Date('2026-09-07T00:00:00.000Z')
  });
  try {
    const first = service.start();
    assert.equal(first.cpu.usagePercent, null);
    const second = service.sample();
    assert.equal(second.cpu.usagePercent, 80);
    service.stop();
    const restarted = service.start();
    assert.equal(restarted.cpu.usagePercent, null);
  } finally {
    service.stop();
  }
});

test('establishes network baseline, computes real byte rates and resets on interface changes', () => {
  const resources = [
    { gpu: { phase: 'unavailable', reason: 'test' }, network: { phase: 'available', interfaceId: 'wifi-1', receivedBytes: 1000, sentBytes: 400 } },
    { gpu: { phase: 'unavailable', reason: 'test' }, network: { phase: 'available', interfaceId: 'wifi-1', receivedBytes: 3000, sentBytes: 800 } },
    { gpu: { phase: 'unavailable', reason: 'test' }, network: { phase: 'available', interfaceId: 'ethernet-2', receivedBytes: 10, sentBytes: 20 } },
    { gpu: { phase: 'available', usagePercent: 12.4 }, network: { phase: 'available', interfaceId: 'ethernet-2', receivedBytes: 1010, sentBytes: 220 } }
  ];
  let monotonic = 0;
  const service = new MetricsService({
    intervalMs: 250,
    readCpu: () => [{ user: monotonic, system: 0, idle: 100 }],
    readMemory: () => ({ total: 100, free: 40 }),
    readResources: () => resources.shift(),
    monotonicNow: () => { monotonic += 1000; return monotonic; },
    now: () => new Date('2026-09-07T00:00:00.000Z')
  });
  service.sample();
  assert.equal(service.snapshot().network.phase, 'baseline');
  service.sample();
  assert.deepEqual(service.snapshot().network, {
    phase: 'available',
    interfaceId: 'wifi-1',
    downloadBytesPerSecond: 2000,
    uploadBytesPerSecond: 400,
    reason: ''
  });
  service.sample();
  assert.equal(service.snapshot().network.phase, 'baseline');
  service.sample();
  assert.equal(service.snapshot().gpu.usagePercent, 12.4);
  service.stop();
});

test('applies asynchronous GPU and network resources without blocking CPU samples', async () => {
  const service = new MetricsService({
    intervalMs: 250,
    readCpu: () => [{ user: 10, system: 5, idle: 85 }],
    readMemory: () => ({ total: 100, free: 40 }),
    readResources: () => Promise.resolve({
      gpu: { phase: 'available', usagePercent: 21.6 },
      network: { phase: 'available', interfaceId: 'wifi-1', mode: 'rate', downloadBytesPerSecond: 900, uploadBytesPerSecond: 40 }
    })
  });
  const initial = service.start();
  assert.equal(initial.gpu.phase, 'baseline');
  await new Promise(resolve => setImmediate(resolve));
  const updated = service.snapshot();
  assert.equal(updated.gpu.usagePercent, 21.6);
  assert.equal(updated.network.phase, 'baseline');
  service.stop();
});

test('does not relabel valid metrics as unavailable while a slow resource sample is pending', async () => {
  let sampleCount = 0;
  let releaseSecond;
  const service = new MetricsService({
    intervalMs: 250,
    readCpu: () => [{ user: 10, system: 5, idle: 85 }],
    readMemory: () => ({ total: 100, free: 40 }),
    readResources: () => {
      sampleCount += 1;
      if (sampleCount === 1) return Promise.resolve({
        gpu: { phase: 'available', usagePercent: 34, adapterKind: 'discrete' },
        network: { phase: 'available', interfaceId: 'wifi-1', mode: 'rate', downloadBytesPerSecond: 900, uploadBytesPerSecond: 40 }
      });
      return new Promise(resolve => { releaseSecond = resolve; });
    }
  });
  service.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.snapshot().gpu.adapterKind, 'discrete');
  assert.equal(service.snapshot().network.phase, 'baseline');
  service.sample();
  assert.equal(service.snapshot().gpu.usagePercent, 34);
  assert.equal(service.snapshot().network.phase, 'baseline');
  releaseSecond({
    gpu: { phase: 'available', usagePercent: 42, adapterKind: 'discrete' },
    network: { phase: 'available', interfaceId: 'wifi-1', mode: 'rate', downloadBytesPerSecond: 1200, uploadBytesPerSecond: 50 }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.snapshot().gpu.usagePercent, 42);
  service.stop();
});
