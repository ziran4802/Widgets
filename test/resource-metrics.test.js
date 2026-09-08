const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { counterValue, normalizeGpuLuid, parseResourceOutput, readSystemResources, readSystemResourcesAsync, selectGpuSample } = require('../src/resource-metrics');

test('parses resource output while preserving unavailable metric semantics', () => {
  const parsed = parseResourceOutput(JSON.stringify({
    gpuPercent: 22.35,
    gpuReason: '',
    network: { interfaceId: 'wifi-1', receivedBytes: '100000000000', sentBytes: '20000000000' },
    networkReason: ''
  }));
  assert.deepEqual(parsed.gpu, { phase: 'available', usagePercent: 22.4, reason: '' });
  assert.deepEqual(parsed.network, { phase: 'available', interfaceId: 'wifi-1', mode: 'counter', receivedBytes: 100000000000, sentBytes: 20000000000, reason: '' });
  assert.equal(counterValue('not-a-counter'), null);
});

test('selects the GPU adapter with dedicated memory instead of the busiest integrated engine', () => {
  assert.equal(normalizeGpuLuid('luid_0x00000000_0x00012fa6_phys_0'), '0000000000012FA6');
  assert.deepEqual(selectGpuSample([
    { instanceName: 'luid_0x00000000_0x00012aa1_phys_0', value: 85 },
    { instanceName: 'luid_0x00000000_0x00012fa6_phys_0', value: 34 }
  ], [
    { instanceName: 'luid_0x00000000_0x00012aa1_phys_0', value: 0 },
    { instanceName: 'luid_0x00000000_0x00012fa6_phys_0', value: 128 * 1024 * 1024 }
  ]), {
    usagePercent: 34,
    luid: '0000000000012FA6',
    adapterKind: 'discrete',
    reason: ''
  });
  const parsed = parseResourceOutput(JSON.stringify({ gpuPercent: 34, gpuAdapterKind: 'discrete', gpuReason: '', network: null, networkReason: 'unavailable' }));
  assert.equal(parsed.gpu.adapterKind, 'discrete');
});

test('reads the Windows provider through an injected process runner and degrades safely', () => {
  const calls = [];
  const result = readSystemResources({
    platform: 'win32',
    command: 'fake-powershell',
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ gpuPercent: 4, gpuReason: '', network: null, networkReason: 'metric=network; reason=no default route' }) };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(result.gpu.usagePercent, 4);
  assert.equal(result.network.phase, 'unavailable');
  const failed = readSystemResources({ platform: 'win32', spawn: () => ({ status: 1, stdout: '' }) });
  assert.equal(failed.gpu.phase, 'unavailable');
  assert.equal(failed.network.phase, 'unavailable');
});

test('parses direct performance-counter rates for the Windows provider', () => {
  const parsed = parseResourceOutput(JSON.stringify({
    gpuPercent: null,
    gpuReason: 'metric=gpu; reason=unavailable',
    network: { interfaceId: 'wifi-1', downloadBytesPerSecond: 80.5, uploadBytesPerSecond: 12.25, mode: 'rate' },
    networkReason: ''
  }));
  assert.deepEqual(parsed.network, { phase: 'available', interfaceId: 'wifi-1', mode: 'rate', downloadBytesPerSecond: 80.5, uploadBytesPerSecond: 12.25, reason: '' });
});

test('reads the Windows provider asynchronously without blocking the caller', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  const pending = readSystemResourcesAsync({
    platform: 'win32',
    spawnProcess: () => {
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({
          gpuPercent: 18.25,
          gpuReason: '',
          network: { interfaceId: 'wifi-1', downloadBytesPerSecond: 1200, uploadBytesPerSecond: 50, mode: 'rate' },
          networkReason: ''
        }));
        child.emit('close', 0);
      });
      return child;
    }
  });
  assert.deepEqual(await pending, {
    gpu: { phase: 'available', usagePercent: 18.3, reason: '' },
    network: { phase: 'available', interfaceId: 'wifi-1', mode: 'rate', downloadBytesPerSecond: 1200, uploadBytesPerSecond: 50, reason: '' }
  });
});
