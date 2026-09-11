const { dipToPhysical, withinTolerance } = require('./m0-contract');

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_NOACTIVATE = 0x08000000;
const GA_ROOT = 2;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOZORDER = 0x0004;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_FRAMECHANGED = 0x0020;

function asBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return BigInt(value || 0);
}

function hwndFromElectron(window, koffi) {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 8) throw new Error('Electron native window handle unavailable');
  return asBigInt(handle.readBigUInt64LE(0));
}

function createUnavailable(reason) {
  return Object.freeze({
    available: false,
    nativeAvailable: false,
    nativeReason: reason,
    attach: () => ({ nativeAvailable: false, nativeReason: reason, success: false, errors: [reason] }),
    observe: () => ({ nativeAvailable: false, nativeReason: reason, success: false, errors: [reason] }),
    setInputMode: () => ({ nativeAvailable: false, nativeReason: reason, success: false, errors: [reason] }),
    setGeometry: () => ({ nativeAvailable: false, nativeReason: reason, success: false, errors: [reason] }),
    capturePointer: () => ({ nativeAvailable: false, nativeReason: reason, operation: 'capture', success: false, errors: [reason] }),
    releasePointer: () => ({ nativeAvailable: false, nativeReason: reason, operation: 'release', success: false, errors: [reason] }),
    samplePoint: () => ({ nativeAvailable: false, nativeReason: reason, success: false, errors: [reason] }),
    restore: () => ({ nativeAvailable: false, nativeReason: reason, success: false, errors: [reason] })
  });
}

function loadNativeHostAdapter(options = {}) {
  if (options.disableNative === true) return createUnavailable('native adapter disabled by WIDGET_M0_DISABLE_NATIVE=1');
  if (process.platform !== 'win32') return createUnavailable(`unsupported platform: ${process.platform}`);
  let koffi;
  try { koffi = require('koffi'); } catch (error) { return createUnavailable(`koffi unavailable: ${error.message}`); }

  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const FindWindowW = user32.func('uintptr_t FindWindowW(const wchar_t * className, const wchar_t * title)');
    const FindWindowExW = user32.func('uintptr_t FindWindowExW(uintptr_t parent, uintptr_t after, const wchar_t * className, const wchar_t * title)');
    const SendMessageTimeoutW = user32.func('uintptr_t SendMessageTimeoutW(uintptr_t window, uint message, uintptr_t wParam, uintptr_t lParam, uint flags, uint timeout, _Out_ void * result)');
    const SetParent = user32.func('uintptr_t SetParent(uintptr_t child, uintptr_t parent)');
    const GetParent = user32.func('uintptr_t GetParent(uintptr_t window)');
    const GetAncestor = user32.func('uintptr_t GetAncestor(uintptr_t window, uint flags)');
    const GetWindowLongPtrW = user32.func('intptr_t GetWindowLongPtrW(uintptr_t window, int index)');
    const SetWindowLongPtrW = user32.func('intptr_t SetWindowLongPtrW(uintptr_t window, int index, intptr_t value)');
    const SetWindowPos = user32.func('bool SetWindowPos(uintptr_t window, uintptr_t after, int x, int y, int cx, int cy, uint flags)');
    const GetWindowRect = user32.func('bool GetWindowRect(uintptr_t window, _Out_ void * rect)');
    const GetClientRect = user32.func('bool GetClientRect(uintptr_t window, _Out_ void * rect)');
    const ClientToScreen = user32.func('bool ClientToScreen(uintptr_t window, _Inout_ void * point)');
    const POINT = koffi.struct({ x: 'int32_t', y: 'int32_t' });
    const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr_t', [POINT]);
    const SetCapture = user32.func('uintptr_t SetCapture(uintptr_t window)');
    const ReleaseCapture = user32.func('bool ReleaseCapture()');
    const GetCapture = user32.func('uintptr_t GetCapture()');
    const IsWindowEnabled = user32.func('bool IsWindowEnabled(uintptr_t window)');
    const EnableWindow = user32.func('bool EnableWindow(uintptr_t window, bool enable)');
    const GetClassNameW = user32.func('int GetClassNameW(uintptr_t window, _Out_ wchar_t * className, int maxCount)');
    const GetLastError = kernel32.func('uint GetLastError()');
    const SetLastError = kernel32.func('void SetLastError(uint error)');
    const inputHosts = new Map();

    function releaseInputHost(state) {
      const lease = inputHosts.get(state.worker);
      if (!lease) return;
      lease.children.delete(state.child);
      if (lease.children.size) return;
      EnableWindow(state.worker, lease.enabledBefore);
      inputHosts.delete(state.worker);
    }

    function acquireInputHost(state) {
      let lease = inputHosts.get(state.worker);
      if (!lease) {
        lease = { enabledBefore: IsWindowEnabled(state.worker), children: new Set() };
        inputHosts.set(state.worker, lease);
      }
      lease.children.add(state.child);
      // Windows 11's wallpaper WorkerW can be disabled. A child cannot take
      // keyboard focus until this parent is enabled. Restore it on last release.
      EnableWindow(state.worker, true);
      return IsWindowEnabled(state.worker);
    }

    function readRect(window) {
      const rect = Buffer.alloc(16);
      return GetWindowRect(window, rect) ? { left: rect.readInt32LE(0), top: rect.readInt32LE(4), right: rect.readInt32LE(8), bottom: rect.readInt32LE(12), unit: 'physical' } : null;
    }

    function readClientScreenRect(window) {
      const rect = Buffer.alloc(16);
      const point = Buffer.alloc(8);
      if (!GetClientRect(window, rect) || !ClientToScreen(window, point)) return null;
      const originX = point.readInt32LE(0);
      const originY = point.readInt32LE(4);
      const left = originX + rect.readInt32LE(0);
      const top = originY + rect.readInt32LE(4);
      const right = originX + rect.readInt32LE(8);
      const bottom = originY + rect.readInt32LE(12);
      return { left, top, right, bottom, width: right - left, height: bottom - top, unit: 'physical' };
    }

    function className(window) {
      if (!window) return '';
      const buffer = Buffer.alloc(512);
      const length = GetClassNameW(window, buffer, 256);
      return length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
    }

    function setWindowLongPtrChecked(window, index, value) {
      SetLastError(0);
      const previous = SetWindowLongPtrW(window, index, value);
      const error = Number(GetLastError());
      return { ok: asBigInt(previous) !== 0n || error === 0, previous, error };
    }

    function locateWorkerW() {
      const progman = asBigInt(FindWindowW('Progman', null));
      if (!progman) return { progman, worker: 0n, topologySource: `ProgmanNotFound:${GetLastError()}` };
      const shellView = asBigInt(FindWindowExW(progman, 0n, 'SHELLDLL_DefView', null));
      const directWorker = asBigInt(FindWindowExW(progman, 0n, 'WorkerW', null));
      if (directWorker && asBigInt(GetParent(directWorker)) === progman) return { progman, shellView, worker: directWorker, topologySource: 'ProgmanDirectWorkerW' };
      const result = Buffer.alloc(8);
      SetLastError(0);
      const messageResult = SendMessageTimeoutW(progman, 0x052C, 0n, 0n, 0x0002, 1000, result);
      const messageError = messageResult ? 0 : Number(GetLastError());
      let after = 0n;
      const workers = [];
      while (true) {
        const candidate = asBigInt(FindWindowExW(0n, after, 'WorkerW', null));
        if (!candidate) break;
        workers.push(candidate);
        after = candidate;
      }
      const directDefViewHost = workers.find(candidate => asBigInt(FindWindowExW(candidate, 0n, 'SHELLDLL_DefView', null)) !== 0n);
      const workerAfterDefViewHost = directDefViewHost ? asBigInt(FindWindowExW(0n, directDefViewHost, 'WorkerW', null)) : 0n;
      if (directDefViewHost && workerAfterDefViewHost) return { progman, shellView, worker: workerAfterDefViewHost, topologySource: 'WorkerWDirectDefViewNext', messageError };
      return { progman, shellView, worker: 0n, topologySource: `WorkerWNotFound:message=${messageError}`, messageError };
    }

    function observe(window, state, bounds, scaleFactor, mode = 'locked', operation = 'validate') {
      const child = hwndFromElectron(window, koffi);
      const expectedPhysical = dipToPhysical(bounds, scaleFactor);
      const parent = asBigInt(GetParent(child));
      const ancestor = asBigInt(GetAncestor(child, GA_ROOT));
      const workerRoot = state?.worker ? asBigInt(GetAncestor(state.worker, GA_ROOT)) : 0n;
      const style = Number(GetWindowLongPtrW(child, GWL_STYLE));
      const exStyle = Number(GetWindowLongPtrW(child, GWL_EXSTYLE));
      const outer = readRect(child);
      const actualClient = readClientScreenRect(child);
      // Locked widgets must remain click-through and non-activating. During
      // editing, NOACTIVATE prevents a real mouse drag from reaching the
      // reparented WS_CHILD window, so only TOOLWINDOW is required there.
      const required = mode === 'editing' ? WS_EX_TOOLWINDOW : WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
      const transparentValid = mode === 'editing' ? (exStyle & WS_EX_TRANSPARENT) === 0 : (exStyle & WS_EX_TRANSPARENT) === WS_EX_TRANSPARENT;
      const activationValid = mode !== 'editing' || (exStyle & WS_EX_NOACTIVATE) === 0;
      const structureValid = Boolean(state?.worker && workerRoot && parent === state.worker && ancestor === workerRoot && (style & WS_CHILD) === WS_CHILD && (exStyle & required) === required && transparentValid && activationValid);
      const clientValid = Boolean(actualClient && withinTolerance(actualClient, expectedPhysical, 1));
      const outerValid = Boolean(outer && withinTolerance(outer, expectedPhysical, 1));
      return { nativeAvailable: true, operation, mode, child, parent, ancestor, worker: state?.worker || 0n, workerRoot, parentClass: className(parent), workerClass: className(state?.worker || 0n), style, exStyle, outer, actualClient, expectedPhysical, scaleFactor, structureValid, clientValid, outerValid, success: structureValid && clientValid, errors: [] };
    }

    function attach(window, bounds, scaleFactor = 1) {
      const child = hwndFromElectron(window, koffi);
      const topology = locateWorkerW();
      const parentBefore = asBigInt(GetParent(child));
      const originalStyle = Number(GetWindowLongPtrW(child, GWL_STYLE));
      const originalExStyle = Number(GetWindowLongPtrW(child, GWL_EXSTYLE));
      const state = { child, ...topology, parentBefore, originalStyle, originalExStyle, scaleFactor };
      const errors = [];
      if (!topology.worker) return { ...state, nativeAvailable: true, operation: 'attach', success: false, errors: ['WorkerW not found'] };
      const desiredStyle = (originalStyle & ~WS_POPUP) | WS_CHILD;
      const styleWrite = setWindowLongPtrChecked(child, GWL_STYLE, desiredStyle);
      if (!styleWrite.ok) errors.push(`SetWindowLongPtr(style) failed:${styleWrite.error}`);
      SetLastError(0);
      SetParent(child, topology.worker);
      if (asBigInt(GetParent(child)) !== topology.worker) errors.push(`SetParent validation failed:${Number(GetLastError())}`);
      const currentExStyle = Number(GetWindowLongPtrW(child, GWL_EXSTYLE));
      const exStyleWrite = setWindowLongPtrChecked(child, GWL_EXSTYLE, currentExStyle | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      if (!exStyleWrite.ok) errors.push(`SetWindowLongPtr(exStyle) failed:${exStyleWrite.error}`);
      const expectedPhysical = dipToPhysical(bounds, scaleFactor);
      const parentClient = readClientScreenRect(topology.worker);
      if (!parentClient) errors.push('WorkerW client geometry unavailable');
      const outerBefore = readRect(child);
      const clientBefore = readClientScreenRect(child);
      const frame = outerBefore && clientBefore ? {
        left: clientBefore.left - outerBefore.left,
        top: clientBefore.top - outerBefore.top,
        right: outerBefore.right - clientBefore.right,
        bottom: outerBefore.bottom - clientBefore.bottom
      } : null;
      if (!frame || Object.values(frame).some(value => !Number.isFinite(value) || value < 0)) errors.push('child frame geometry unavailable');
      if (parentClient && frame && !SetWindowPos(child, 0n,
        expectedPhysical.left - parentClient.left - frame.left,
        expectedPhysical.top - parentClient.top - frame.top,
        expectedPhysical.width + frame.left + frame.right,
        expectedPhysical.height + frame.top + frame.bottom,
        SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED)) errors.push(`SetWindowPos failed:${Number(GetLastError())}`);
      const observation = observe(window, state, bounds, scaleFactor, 'locked', 'attach');
      const result = { ...state, ...observation, frame, parentClientOrigin: parentClient, styleWrite, exStyleWrite, inputMode: 'locked', errors: [...errors, ...observation.errors], success: errors.length === 0 && observation.success };
      if (!result.success) restore(window, state);
      return result;
    }

    function setInputMode(window, state, mode, bounds) {
      if (!state?.worker) return { nativeAvailable: true, operation: 'input', success: false, errors: ['host is not attached'] };
      const child = hwndFromElectron(window, koffi);
      const current = Number(GetWindowLongPtrW(child, GWL_EXSTYLE));
      const next = mode === 'editing'
        ? (current & ~(WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)) | WS_EX_TOOLWINDOW
        : current | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
      const write = setWindowLongPtrChecked(child, GWL_EXSTYLE, next);
      // Reparented Electron windows can keep their old hit-test behavior until
      // Windows is told to recalculate the non-client/style state. Without
      // this refresh the renderer can report an interactive mode while the
      // WorkerW child still behaves as click-through.
      SetLastError(0);
      const refreshed = SetWindowPos(child, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      const refreshError = refreshed ? 0 : Number(GetLastError());
      const hostEnabled = mode !== 'editing' || (write.ok && refreshed && acquireInputHost({ ...state, child }));
      if (mode !== 'editing') releaseInputHost({ ...state, child });
      const observation = observe(window, state, bounds, state.scaleFactor || 1, mode, 'input');
      if (mode === 'editing' && state.inputMode !== 'editing' && (!hostEnabled || !observation.structureValid)) releaseInputHost({ ...state, child });
      if (write.ok && refreshed && hostEnabled && observation.structureValid) state.inputMode = mode;
      const errors = [];
      if (!write.ok) errors.push(`SetWindowLongPtr(exStyle) failed:${write.error}`);
      if (!refreshed) errors.push(`SetWindowPos(style refresh) failed:${refreshError}`);
      if (!hostEnabled) errors.push('WorkerW input host remains disabled');
      return { ...observation, write, refreshed, refreshError, hostEnabled, success: write.ok && refreshed && hostEnabled && observation.structureValid, errors: [...errors, ...observation.errors] };
    }

    function setGeometry(window, state, bounds) {
      if (!state?.worker) return { nativeAvailable: true, operation: 'geometry', success: false, errors: ['host is not attached'] };
      const child = hwndFromElectron(window, koffi);
      const scaleFactor = state.scaleFactor || 1;
      const expectedPhysical = dipToPhysical(bounds, scaleFactor);
      const parentClient = readClientScreenRect(state.worker);
      const outer = readRect(child);
      const client = readClientScreenRect(child);
      const errors = [];
      if (!parentClient || !outer || !client) errors.push('geometry readback unavailable');
      const frame = parentClient && outer && client ? { left: client.left - outer.left, top: client.top - outer.top, right: outer.right - client.right, bottom: outer.bottom - client.bottom } : null;
      if (!frame || Object.values(frame).some(value => !Number.isFinite(value) || value < 0)) errors.push('child frame geometry invalid');
      if (!errors.length && !SetWindowPos(child, 0n, expectedPhysical.left - parentClient.left - frame.left, expectedPhysical.top - parentClient.top - frame.top, expectedPhysical.width + frame.left + frame.right, expectedPhysical.height + frame.top + frame.bottom, SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED)) errors.push(`SetWindowPos(client) failed:${Number(GetLastError())}`);
      const observation = observe(window, state, bounds, scaleFactor, state.inputMode || 'locked', 'geometry');
      return { ...observation, frame, parentClientOrigin: parentClient, errors: [...errors, ...observation.errors], success: errors.length === 0 && observation.clientValid };
    }

    function samplePoint(window, point) {
      const child = hwndFromElectron(window, koffi);
      const nativePoint = { x: Math.trunc(point.x), y: Math.trunc(point.y) };
      const hitWindow = asBigInt(WindowFromPoint(nativePoint));
      const hitParent = asBigInt(GetParent(hitWindow));
      const hitAncestor = asBigInt(GetAncestor(hitWindow, GA_ROOT));
      return { nativeAvailable: true, operation: 'input-hit', success: true, point, child, hitWindow, hitParent, hitAncestor, hitIsCard: hitWindow === child, hitClass: className(hitWindow), parentClass: className(hitParent), ancestorClass: className(hitAncestor), errors: [] };
    }

    function capturePointer(window) {
      const child = hwndFromElectron(window, koffi);
      SetCapture(child);
      const captured = asBigInt(GetCapture());
      return { nativeAvailable: true, operation: 'capture', child, captured, success: captured === child, errors: captured === child ? [] : ['SetCapture validation failed'] };
    }

    function releasePointer(window) {
      const child = hwndFromElectron(window, koffi);
      if (asBigInt(GetCapture()) === child) ReleaseCapture();
      const captured = asBigInt(GetCapture());
      return { nativeAvailable: true, operation: 'release', child, captured, success: captured !== child, errors: captured === child ? ['ReleaseCapture validation failed'] : [] };
    }

    function restore(window, state = {}) {
      const child = hwndFromElectron(window, koffi);
      releaseInputHost({ ...state, child });
      const errors = [];
      if (state.parentBefore !== undefined) SetParent(child, state.parentBefore);
      if (state.originalStyle !== undefined) setWindowLongPtrChecked(child, GWL_STYLE, state.originalStyle);
      if (state.originalExStyle !== undefined) setWindowLongPtrChecked(child, GWL_EXSTYLE, state.originalExStyle);
      if (state.parentBefore !== undefined && asBigInt(GetParent(child)) !== asBigInt(state.parentBefore)) errors.push('restore parent validation failed');
      return { nativeAvailable: true, operation: 'restore', success: errors.length === 0, parent: asBigInt(GetParent(child)), style: Number(GetWindowLongPtrW(child, GWL_STYLE)), exStyle: Number(GetWindowLongPtrW(child, GWL_EXSTYLE)), errors };
    }

    const startMouseRouter = getTargets => require('./desktop-input-router').startDesktopInputRouter({ koffi, getTargets });
    return Object.freeze({ available: true, nativeAvailable: true, attach, observe, setInputMode, setGeometry, capturePointer, releasePointer, samplePoint, restore, startMouseRouter });
  } catch (error) {
    return createUnavailable(`native adapter initialization failed: ${error.message}`);
  }
}

module.exports = { loadNativeHostAdapter };
