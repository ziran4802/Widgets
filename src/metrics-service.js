const os = require('node:os');
const { EventEmitter } = require('node:events');
const { readSystemResourcesAsync } = require('./resource-metrics');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readCpuTimes(cpuReader = os.cpus) {
  return cpuReader().map(cpu => ({ ...cpu.times }));
}

function readMemory(memoryReader = () => ({ total: os.totalmem(), free: os.freemem() })) {
  const memory = memoryReader();
  if (!memory || !Number.isFinite(memory.total) || !Number.isFinite(memory.free) || memory.total <= 0 || memory.free < 0) {
    throw new TypeError('memory sample is invalid');
  }
  const total = memory.total;
  const free = Math.min(memory.free, total);
  const used = total - free;
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    usagePercent: Math.round((used / total) * 1000) / 10
  };
}

function cpuUsagePercent(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || previous.length === 0 || current.length === 0) return null;
  const count = Math.min(previous.length, current.length);
  let totalDelta = 0;
  let busyDelta = 0;
  for (let index = 0; index < count; index += 1) {
    const before = previous[index];
    const after = current[index];
    const beforeTotal = Object.values(before).reduce((sum, value) => sum + Number(value || 0), 0);
    const afterTotal = Object.values(after).reduce((sum, value) => sum + Number(value || 0), 0);
    const total = afterTotal - beforeTotal;
    const idle = Number(after.idle || 0) - Number(before.idle || 0);
    if (total > 0) {
      totalDelta += total;
      busyDelta += Math.max(0, total - idle);
    }
  }
  if (totalDelta <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((busyDelta / totalDelta) * 1000) / 10));
}

function unavailableGpu(reason = 'metric=gpu; reason=unavailable') {
  return { phase: 'unavailable', usagePercent: null, reason };
}

function unavailableNetwork(reason = 'metric=network; reason=unavailable') {
  return { phase: 'unavailable', interfaceId: null, downloadBytesPerSecond: null, uploadBytesPerSecond: null, reason };
}

class MetricsService extends EventEmitter {
  constructor({ intervalMs = 1000, readCpu = () => readCpuTimes(), readMemory: memoryReader, readResources = signal => readSystemResourcesAsync({ signal }), monotonicNow = () => Number(process.hrtime.bigint() / 1000000n), now = () => new Date() } = {}) {
    super();
    if (!Number.isInteger(intervalMs) || intervalMs < 250) throw new TypeError('intervalMs must be at least 250ms');
    this.intervalMs = intervalMs;
    this.readCpu = readCpu;
    this.readMemory = memoryReader || (() => readMemory());
    this.readResources = readResources;
    this.monotonicNow = monotonicNow;
    this.now = now;
    this.previousCpu = null;
    this.networkBaseline = undefined;
    this.resourcePending = false;
    this.resourceAbortController = undefined;
    this.resourceSequence = 0;
    this.current = {
      phase: 'idle',
      at: undefined,
      cpu: { phase: 'baseline', usagePercent: null, logicalCores: 0, reason: 'metric=cpu; reason=baseline pending' },
      memory: undefined,
      gpu: unavailableGpu('metric=gpu; reason=baseline pending'),
      network: unavailableNetwork('metric=network; reason=baseline pending')
    };
    this.timer = undefined;
  }

  snapshot() {
    return clone(this.current);
  }

  start() {
    if (this.timer) return this.snapshot();
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    return this.snapshot();
  }

  sample() {
    const sampledAt = this.now();
    const sampledAtText = sampledAt.toISOString();
    let cpu;
    let memory;
    let basePhase = 'ready';
    let baseError;
    try {
      cpu = this.readCpu();
      memory = this.readMemory();
      if (!Array.isArray(cpu) || cpu.length === 0) throw new TypeError('cpu sample is invalid');
      const usagePercent = cpuUsagePercent(this.previousCpu, cpu);
      this.previousCpu = cpu.map(item => ({ ...item }));
      const cpuMetric = {
        phase: usagePercent === null ? 'baseline' : 'available',
        usagePercent,
        logicalCores: cpu.length,
        reason: usagePercent === null ? 'metric=cpu; reason=baseline pending' : ''
      };
      const wasResourcePending = this.resourcePending;
      let resources;
      if (this.resourcePending) {
        resources = undefined;
      } else {
        try {
          this.resourceAbortController = new AbortController();
          resources = this.readResources(this.resourceAbortController.signal);
        } catch { resources = undefined; }
      }
      const asyncResources = resources && typeof resources.then === 'function';
      if (asyncResources) {
        this.resourcePending = true;
        const sequence = ++this.resourceSequence;
        resources.then(value => {
          if (sequence !== this.resourceSequence || !this.timer) return;
          this.resourcePending = false;
          this.applyResources(value);
          this.emit('update', this.snapshot());
        }).catch(() => {
          if (sequence !== this.resourceSequence || !this.timer) return;
          this.resourcePending = false;
          this.applyResources(undefined);
          this.emit('update', this.snapshot());
        });
      }
      const resourceMetrics = asyncResources || wasResourcePending
        ? this.resourceMetrics(undefined, { pending: true })
        : this.resourceMetrics(resources);
      this.current = { phase: basePhase, at: sampledAtText, cpu: cpuMetric, memory, ...resourceMetrics };
    } catch {
      basePhase = 'degraded';
      baseError = { code: 'METRICS_READ_FAILED', message: '系统指标暂时不可用' };
      this.current = {
        phase: basePhase,
        at: sampledAtText,
        cpu: { phase: 'unavailable', usagePercent: null, logicalCores: 0, reason: 'metric=cpu; reason=read failed' },
        memory: undefined,
        gpu: unavailableGpu(),
        network: unavailableNetwork(),
        error: baseError
      };
    }
    this.emit('update', this.snapshot());
    return this.snapshot();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.previousCpu = null;
    this.networkBaseline = undefined;
    this.resourceSequence += 1;
    this.resourcePending = false;
    this.resourceAbortController?.abort();
    this.resourceAbortController = undefined;
  }

  resourceMetrics(resources, { pending = false } = {}) {
    if (pending) {
      const gpu = this.current.gpu?.phase === 'available'
        ? { ...this.current.gpu }
        : { phase: 'baseline', usagePercent: null, reason: 'metric=gpu; reason=sample pending' };
      const network = this.current.network?.phase === 'available' || this.current.network?.phase === 'baseline'
        ? { ...this.current.network }
        : { phase: 'baseline', interfaceId: null, downloadBytesPerSecond: null, uploadBytesPerSecond: null, reason: 'metric=network; reason=sample pending' };
      return { gpu, network };
    }
    const gpu = resources?.gpu?.phase === 'available' && Number.isFinite(resources.gpu.usagePercent)
      ? { phase: 'available', usagePercent: Math.min(100, Math.max(0, resources.gpu.usagePercent)), reason: '', ...(resources.gpu.adapterKind ? { adapterKind: resources.gpu.adapterKind } : {}) }
      : unavailableGpu(resources?.gpu?.reason || 'metric=gpu; reason=waiting');
    const network = this.sampleNetwork(resources?.network, this.monotonicNow());
    return { gpu, network };
  }

  applyResources(resources) {
    const metrics = this.resourceMetrics(resources);
    this.current = { ...this.current, gpu: metrics.gpu, network: metrics.network };
  }

  sampleNetwork(resource, now) {
    if (resource?.phase === 'available' && resource.mode === 'rate' && typeof resource.interfaceId === 'string' && Number.isFinite(resource.downloadBytesPerSecond) && Number.isFinite(resource.uploadBytesPerSecond)) {
      const current = { interfaceId: resource.interfaceId, at: now };
      if (!this.networkBaseline || this.networkBaseline.mode !== 'rate' || this.networkBaseline.interfaceId !== current.interfaceId || current.at <= this.networkBaseline.at) {
        this.networkBaseline = { ...current, mode: 'rate' };
        return { phase: 'baseline', interfaceId: current.interfaceId, downloadBytesPerSecond: null, uploadBytesPerSecond: null, reason: 'metric=network; reason=baseline established' };
      }
      this.networkBaseline = { ...current, mode: 'rate' };
      return {
        phase: 'available',
        interfaceId: current.interfaceId,
        downloadBytesPerSecond: Math.max(0, resource.downloadBytesPerSecond),
        uploadBytesPerSecond: Math.max(0, resource.uploadBytesPerSecond),
        reason: ''
      };
    }
    if (!resource || resource.phase !== 'available' || typeof resource.interfaceId !== 'string' || !Number.isSafeInteger(resource.receivedBytes) || !Number.isSafeInteger(resource.sentBytes)) {
      this.networkBaseline = undefined;
      return unavailableNetwork(resource?.reason || 'metric=network; reason=unavailable');
    }
    const current = { interfaceId: resource.interfaceId, receivedBytes: resource.receivedBytes, sentBytes: resource.sentBytes, at: now };
    if (!this.networkBaseline) {
      this.networkBaseline = current;
      return { phase: 'baseline', interfaceId: current.interfaceId, downloadBytesPerSecond: null, uploadBytesPerSecond: null, reason: 'metric=network; reason=baseline established' };
    }
    const previous = this.networkBaseline;
    const elapsedSeconds = (current.at - previous.at) / 1000;
    if (current.interfaceId !== previous.interfaceId || current.receivedBytes < previous.receivedBytes || current.sentBytes < previous.sentBytes || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      this.networkBaseline = current;
      return { phase: 'baseline', interfaceId: current.interfaceId, downloadBytesPerSecond: null, uploadBytesPerSecond: null, reason: 'metric=network; reason=interface or counter baseline reset' };
    }
    this.networkBaseline = current;
    return {
      phase: 'available',
      interfaceId: current.interfaceId,
      downloadBytesPerSecond: Math.max(0, (current.receivedBytes - previous.receivedBytes) / elapsedSeconds),
      uploadBytesPerSecond: Math.max(0, (current.sentBytes - previous.sentBytes) / elapsedSeconds),
      reason: ''
    };
  }
}

module.exports = { MetricsService, cpuUsagePercent, readCpuTimes, readMemory, unavailableGpu, unavailableNetwork };
