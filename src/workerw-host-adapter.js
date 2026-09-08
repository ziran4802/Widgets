function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isAlive(window) {
  return window && (typeof window.isDestroyed !== 'function' || !window.isDestroyed());
}

function operationResult(result, operation, state) {
  return { ...result, operation, state };
}

class WorkerWHostAdapter {
  constructor({ nativeHost, createWindow, getDisplay } = {}) {
    if (!nativeHost || typeof nativeHost !== 'object') throw new TypeError('nativeHost is required');
    if (typeof createWindow !== 'function') throw new TypeError('createWindow is required');
    if (getDisplay !== undefined && typeof getDisplay !== 'function') throw new TypeError('getDisplay must be a function');
    for (const method of ['attach', 'observe', 'setInputMode', 'setGeometry', 'restore']) {
      if (typeof nativeHost[method] !== 'function') throw new TypeError(`nativeHost.${method} is required`);
    }
    this.nativeHost = nativeHost;
    this.createWindow = createWindow;
    this.getDisplay = getDisplay;
    this.registeredWindows = new Map();
  }

  registerWindow(instanceId, handle) {
    if (typeof instanceId !== 'string' || instanceId.length === 0 || !handle) throw new TypeError('instanceId and handle are required');
    this.registeredWindows.set(instanceId, handle);
  }

  resolveScaleFactor(targetDisplay, previousState) {
    let display = targetDisplay;
    if (this.getDisplay) display = this.getDisplay(targetDisplay);
    const scaleFactor = display && typeof display === 'object' ? display.scaleFactor : undefined;
    if (finitePositive(scaleFactor)) return scaleFactor;
    if (finitePositive(previousState?.scaleFactor)) return previousState.scaleFactor;
    return 1;
  }

  state(nativeState, scaleFactor) {
    return { nativeState, scaleFactor };
  }

  async create(instance, bounds) {
    const registered = this.registeredWindows.get(instance.instanceId);
    this.registeredWindows.delete(instance.instanceId);
    const handle = registered || await this.createWindow(instance, bounds);
    if (!handle) throw new Error('WorkerW window could not be created');
    return { handle, state: this.state(undefined, undefined) };
  }

  async attach(handle, targetDisplay, bounds, _generation) {
    const scaleFactor = this.resolveScaleFactor(targetDisplay);
    const result = this.nativeHost.attach(handle, bounds, scaleFactor);
    return operationResult(result, 'attach', this.state(result, scaleFactor));
  }

  async validate(handle, hostState, bounds, mode, _generation) {
    const state = hostState || this.state(undefined, undefined);
    const result = this.nativeHost.observe(handle, state.nativeState, bounds, state.scaleFactor || 1, mode, 'validate');
    return operationResult(result, 'validate', state);
  }

  async setInputMode(handle, hostState, mode, bounds, _generation) {
    const state = hostState || this.state(undefined, undefined);
    const result = this.nativeHost.setInputMode(handle, state.nativeState, mode, bounds);
    return operationResult(result, 'input', state);
  }

  async setGeometry(handle, hostState, bounds, _generation) {
    const state = hostState || this.state(undefined, undefined);
    const result = this.nativeHost.setGeometry(handle, state.nativeState, bounds);
    return operationResult(result, 'geometry', state);
  }

  async capturePointer(handle, hostState, _generation) {
    const state = hostState || this.state(undefined, undefined);
    if (typeof this.nativeHost.capturePointer !== 'function') return operationResult({ success: true, captured: false }, 'capture', state);
    return operationResult(this.nativeHost.capturePointer(handle), 'capture', state);
  }

  async releasePointer(handle, hostState, _generation) {
    const state = hostState || this.state(undefined, undefined);
    if (typeof this.nativeHost.releasePointer !== 'function') return operationResult({ success: true, captured: false }, 'release', state);
    return operationResult(this.nativeHost.releasePointer(handle), 'release', state);
  }

  async recover(handle, hostState, generation, bounds) {
    const state = hostState || this.state(undefined, undefined);
    const restored = this.nativeHost.restore(handle, state.nativeState || {});
    if (restored?.success !== true) return operationResult({ ...restored, errors: ['host restore before recovery failed', ...(restored?.errors || [])] }, 'recover', state);
    const result = this.nativeHost.attach(handle, bounds, state.scaleFactor || 1);
    return operationResult(result, 'recover', this.state(result, state.scaleFactor || 1));
  }

  async detach(handle, hostState, _generation) {
    const state = hostState || this.state(undefined, undefined);
    const result = this.nativeHost.restore(handle, state.nativeState || {});
    return operationResult(result, 'detach', state);
  }

  async destroy(handle, hostState, generation) {
    const detached = await this.detach(handle, hostState, generation);
    if (detached.success !== true) return operationResult(detached, 'destroy', hostState);
    if (isAlive(handle) && typeof handle.close === 'function') {
      try { handle.close(); } catch { return operationResult({ success: false, errors: ['window close failed'] }, 'destroy', hostState); }
    }
    return operationResult({ success: true, errors: [] }, 'destroy', hostState);
  }
}

module.exports = { WorkerWHostAdapter };
