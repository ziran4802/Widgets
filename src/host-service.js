const { normalizeBounds } = require('./config-contract');

const MODES = Object.freeze(['locked', 'editing']);

class HostServiceError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'HostServiceError';
    this.code = code;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarize(result) {
  const summary = {
    operation: typeof result?.operation === 'string' ? result.operation : undefined,
    success: result?.success === true
  };
  if (typeof result?.errorCode === 'string') summary.errorCode = result.errorCode;
  if (Array.isArray(result?.errors)) summary.errors = result.errors.filter(error => typeof error === 'string').slice(0, 8);
  return summary;
}

function staleResult(generation) {
  return { ok: false, errorCode: 'STALE_OPERATION', generation };
}

class HostService {
  constructor({ adapter } = {}) {
    if (!adapter || typeof adapter !== 'object') throw new TypeError('adapter is required');
    for (const method of ['create', 'attach', 'validate', 'setInputMode', 'setGeometry', 'recover', 'detach', 'destroy']) {
      if (typeof adapter[method] !== 'function') throw new TypeError(`adapter.${method} is required`);
    }
    this.adapter = adapter;
    this.records = new Map();
  }

  getSnapshot() {
    return [...this.records.values()].map(record => ({
      instanceId: record.instanceId,
      generation: record.generation,
      phase: record.phase,
      mode: record.mode,
      bounds: clone(record.bounds),
      lastResult: record.lastResult ? clone(record.lastResult) : undefined
    }));
  }

  getRecord(instanceId) {
    const record = this.records.get(instanceId);
    if (!record) throw new HostServiceError('HOST_NOT_FOUND', 'host instance does not exist');
    return record;
  }

  normalizeInstance(instance) {
    if (!instance || typeof instance !== 'object' || typeof instance.instanceId !== 'string' || instance.instanceId.length === 0) {
      throw new HostServiceError('INVALID_INSTANCE', 'host instance is invalid');
    }
    let bounds;
    try { bounds = normalizeBounds(instance.bounds); } catch (error) { throw new HostServiceError('INVALID_BOUNDS', 'host bounds are invalid', error); }
    return { instanceId: instance.instanceId, bounds };
  }

  async create(instance) {
    const normalized = this.normalizeInstance(instance);
    if (this.records.has(normalized.instanceId)) throw new HostServiceError('HOST_ALREADY_EXISTS', 'host instance already exists');
    let created;
    try { created = await this.adapter.create(normalized, clone(normalized.bounds)); } catch (error) { throw new HostServiceError('HOST_CREATE_FAILED', 'host creation failed', error); }
    const record = {
      instanceId: normalized.instanceId,
      handle: created && Object.prototype.hasOwnProperty.call(created, 'handle') ? created.handle : created,
      hostState: created?.state,
      generation: 1,
      phase: 'created',
      mode: 'locked',
      bounds: clone(normalized.bounds),
      lastResult: { operation: 'create', success: true }
    };
    this.records.set(record.instanceId, record);
    return this.getSnapshot().find(item => item.instanceId === record.instanceId);
  }

  async attach(instanceId, targetDisplay) {
    const record = this.getRecord(instanceId);
    const generation = record.generation;
    record.phase = 'attaching';
    let result;
    try {
      result = await this.adapter.attach(record.handle, targetDisplay, clone(record.bounds), generation);
    } catch (error) {
      record.lastResult = { operation: 'attach', success: false, errorCode: 'HOST_ATTACH_FAILED' };
      record.phase = 'unavailable';
      throw new HostServiceError('HOST_ATTACH_FAILED', 'host attach failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.hostState = result?.state ?? record.hostState;
    record.lastResult = summarize(result);
    record.phase = result?.success === true ? 'ready' : 'unavailable';
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }

  async validate(instanceId, expectedBounds) {
    const record = this.getRecord(instanceId);
    let expected;
    try { expected = expectedBounds === undefined ? clone(record.bounds) : normalizeBounds(expectedBounds); } catch (error) { throw new HostServiceError('INVALID_BOUNDS', 'host bounds are invalid', error); }
    if (!['ready', 'editing'].includes(record.phase)) throw new HostServiceError('HOST_NOT_READY', 'host is not ready');
    const generation = record.generation;
    let result;
    try {
      result = await this.adapter.validate(record.handle, record.hostState, clone(expected), record.mode, generation);
    } catch (error) {
      record.lastResult = { operation: 'validate', success: false, errorCode: 'HOST_VALIDATE_FAILED' };
      record.phase = 'unavailable';
      throw new HostServiceError('HOST_VALIDATE_FAILED', 'host validation failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.lastResult = summarize(result);
    if (result?.success !== true) record.phase = 'unavailable';
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }

  async setInputMode(instanceId, mode) {
    if (!MODES.includes(mode)) throw new HostServiceError('INVALID_INPUT_MODE', 'input mode is not supported');
    const record = this.getRecord(instanceId);
    if (!['ready', 'editing'].includes(record.phase)) throw new HostServiceError('HOST_NOT_READY', 'host is not ready');
    const generation = record.generation;
    let result;
    try {
      result = await this.adapter.setInputMode(record.handle, record.hostState, mode, clone(record.bounds), generation);
    } catch (error) {
      record.lastResult = { operation: 'input', success: false, errorCode: 'HOST_INPUT_FAILED' };
      record.phase = 'unavailable';
      throw new HostServiceError('HOST_INPUT_FAILED', 'host input mode failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.lastResult = summarize(result);
    if (result?.success === true) {
      record.mode = mode;
      record.phase = mode === 'editing' ? 'editing' : 'ready';
    }
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }

  async setGeometry(instanceId, bounds) {
    const record = this.getRecord(instanceId);
    let nextBounds;
    try { nextBounds = normalizeBounds(bounds); } catch (error) { throw new HostServiceError('INVALID_BOUNDS', 'host bounds are invalid', error); }
    if (!['ready', 'editing'].includes(record.phase)) throw new HostServiceError('HOST_NOT_READY', 'host is not ready');
    const generation = record.generation;
    let result;
    try {
      result = await this.adapter.setGeometry(record.handle, record.hostState, clone(nextBounds), generation);
    } catch (error) {
      record.lastResult = { operation: 'geometry', success: false, errorCode: 'HOST_GEOMETRY_FAILED' };
      record.phase = 'unavailable';
      throw new HostServiceError('HOST_GEOMETRY_FAILED', 'host geometry failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.lastResult = summarize(result);
    if (result?.success === true) record.bounds = clone(nextBounds);
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }

  async capturePointer(instanceId) {
    const record = this.getRecord(instanceId);
    if (!['ready', 'editing'].includes(record.phase)) throw new HostServiceError('HOST_NOT_READY', 'host is not ready');
    if (typeof this.adapter.capturePointer !== 'function') return { operation: 'capture', success: true, captured: false };
    const generation = record.generation;
    let result;
    try {
      result = await this.adapter.capturePointer(record.handle, record.hostState, generation);
    } catch (error) {
      throw new HostServiceError('HOST_POINTER_CAPTURE_FAILED', 'host pointer capture failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    return result;
  }

  async releasePointer(instanceId) {
    const record = this.getRecord(instanceId);
    if (typeof this.adapter.releasePointer !== 'function') return { operation: 'release', success: true, captured: false };
    const generation = record.generation;
    let result;
    try {
      result = await this.adapter.releasePointer(record.handle, record.hostState, generation);
    } catch (error) {
      throw new HostServiceError('HOST_POINTER_RELEASE_FAILED', 'host pointer release failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    return result;
  }

  async recover(instanceId) {
    const record = this.getRecord(instanceId);
    const generation = ++record.generation;
    record.phase = 'recovering';
    let result;
    try {
      result = await this.adapter.recover(record.handle, record.hostState, generation, clone(record.bounds));
    } catch (error) {
      record.lastResult = { operation: 'recover', success: false, errorCode: 'HOST_RECOVER_FAILED' };
      record.phase = 'unavailable';
      throw new HostServiceError('HOST_RECOVER_FAILED', 'host recovery failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.hostState = result?.state ?? record.hostState;
    record.lastResult = summarize(result);
    record.phase = result?.success === true ? (record.mode === 'editing' ? 'editing' : 'ready') : 'unavailable';
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }

  async detach(instanceId) {
    const record = this.getRecord(instanceId);
    const generation = ++record.generation;
    let result;
    try {
      result = await this.adapter.detach(record.handle, record.hostState, generation);
    } catch (error) {
      record.lastResult = { operation: 'detach', success: false, errorCode: 'HOST_DETACH_FAILED' };
      record.phase = 'unavailable';
      throw new HostServiceError('HOST_DETACH_FAILED', 'host detach failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.lastResult = summarize(result);
    record.phase = result?.success === true ? 'detached' : 'unavailable';
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }

  async destroy(instanceId) {
    const record = this.getRecord(instanceId);
    const generation = ++record.generation;
    let result;
    try {
      result = await this.adapter.destroy(record.handle, record.hostState, generation);
    } catch (error) {
      record.lastResult = { operation: 'destroy', success: false, errorCode: 'HOST_DESTROY_FAILED' };
      record.phase = 'failed';
      throw new HostServiceError('HOST_DESTROY_FAILED', 'host destruction failed', error);
    }
    if (this.records.get(instanceId) !== record || record.generation !== generation) return staleResult(generation);
    record.lastResult = summarize(result);
    if (result?.success === true) {
      this.records.delete(instanceId);
      return { ok: true, instanceId, generation };
    }
    record.phase = 'failed';
    return this.getSnapshot().find(item => item.instanceId === instanceId);
  }
}

module.exports = { HostService, HostServiceError, MODES };
