function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const DEFAULT_COMPONENT_OPACITY = 0.92;

function resolveComponent(component, settings = {}) {
  const next = clone(component);
  if (!next.theme || !settings) return next;
  const followsGlobalTheme = next.theme.name === 'system';
  const followsGlobalOpacity = followsGlobalTheme && next.theme.opacity === DEFAULT_COMPONENT_OPACITY;
  next.theme = {
    ...next.theme,
    name: followsGlobalTheme && typeof settings.theme === 'string' ? settings.theme : next.theme.name,
    opacity: followsGlobalOpacity && Number.isFinite(settings.opacity) ? settings.opacity : next.theme.opacity
  };
  return next;
}

function toWindowBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  };
}

const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_CAPTURECHANGED = 0x0215;
const NATIVE_POINTER_ID = 0;

function buildWidgetWindowOptions(component, preloadPath) {
  return {
    ...toWindowBounds(component.bounds),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    title: `Widget · ${component.displayName}`,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

class WidgetWindowService {
  constructor({ createWindow, preloadPath, pagePath, onMove = () => {}, hostService, hostTargetDisplay = 'primary', onHostState = () => {}, onWindowClosed = () => {}, getCursorPoint } = {}) {
    if (typeof createWindow !== 'function') throw new TypeError('createWindow is required');
    if (typeof preloadPath !== 'string' || typeof pagePath !== 'string') throw new TypeError('preloadPath and pagePath are required');
    if (typeof onMove !== 'function') throw new TypeError('onMove must be a function');
    if (hostService !== undefined && (!hostService || typeof hostService.create !== 'function' || typeof hostService.attach !== 'function')) throw new TypeError('hostService must expose create and attach');
    if (typeof onHostState !== 'function') throw new TypeError('onHostState must be a function');
    if (typeof onWindowClosed !== 'function') throw new TypeError('onWindowClosed must be a function');
    if (getCursorPoint !== undefined && typeof getCursorPoint !== 'function') throw new TypeError('getCursorPoint must be a function');
    this.createWindow = createWindow;
    this.preloadPath = preloadPath;
    this.pagePath = pagePath;
    this.onMove = onMove;
    this.hostService = hostService;
    this.hostTargetDisplay = hostTargetDisplay;
    this.onHostState = onHostState;
    this.onWindowClosed = onWindowClosed;
    this.getCursorPoint = getCursorPoint;
    this.windows = new Map();
    this.latestMetrics = undefined;
    this.latestCodexQuota = undefined;
    this.closing = false;
    this.temporaryHidden = false;
    this.temporarilyVisibleIds = new Set();
    this.noteFlushSequence = 0;
  }

  isAlive(window) {
    return window && (typeof window.isDestroyed !== 'function' || !window.isDestroyed());
  }

  send(record, channel, payload) {
    if (!record.loaded || !this.isAlive(record.window) || !record.window.webContents || typeof record.window.webContents.send !== 'function') return;
    record.window.webContents.send(channel, clone(payload));
  }

  sendCurrent(record) {
    this.send(record, 'widget:state', record.component);
    this.send(record, 'widget:edit-mode', this.editModePayload(record));
    if (this.latestMetrics) this.send(record, 'widget:metrics', this.latestMetrics);
    if (this.latestCodexQuota) this.send(record, 'widget:codex-quota', this.latestCodexQuota);
  }

  editModePayload(record) {
    return {
      editing: record.editing,
      dragMode: record.hostMode === 'desktop' ? 'native-message' : 'electron-native',
      interactive: record.component.type === 'daily-todo' ? record.todoInteractive !== false : true
    };
  }

  isInteractive(record) {
    return Boolean(record?.editing || (record?.component?.type === 'daily-todo' && record.todoInteractive !== false));
  }

  inputMode(record) {
    return this.isInteractive(record) ? 'editing' : 'locked';
  }

  hostInputSucceeded(state) {
    return state?.lastResult?.success !== false;
  }

  createRecord(component) {
    const record = { component: clone(component), loaded: false, window: undefined, editing: false, todoInteractive: component.type === 'daily-todo', moveSequence: 0, drag: undefined, nativeDrag: false, nativeDragTask: Promise.resolve(), nativeDragHooks: [], noteFlushes: new Map(), hostMode: this.hostService ? 'desktop' : 'floating', hostReady: !this.hostService, hostPhase: this.hostService ? 'creating' : 'floating', hostTask: Promise.resolve() };
    record.window = this.createWindow(buildWidgetWindowOptions(component, this.preloadPath));
    if (!record.window) throw new Error('widget window could not be created');
    this.windows.set(component.instanceId, record);
    const handleRenderProcessGone = (_event, details = {}) => {
      if (this.closing || record.suppressRecovery || !this.isAlive(record.window)) return;
      record.closeReason = `render process gone: ${typeof details.reason === 'string' ? details.reason : 'unknown'}`;
      try { record.window.close?.(); } catch {}
    };
    if (record.window.webContents && typeof record.window.webContents.on === 'function') {
      record.window.webContents.on('did-finish-load', () => {
        record.loaded = true;
        this.sendCurrent(record);
        if (!this.temporaryHidden && record.component.visible && record.hostReady && this.isAlive(record.window) && typeof record.window.show === 'function') record.window.show();
      });
      record.window.webContents.on('render-process-gone', handleRenderProcessGone);
    }
    if (typeof record.window.on === 'function') {
      record.window.on('closed', () => {
        this.uninstallNativeDragHooks(record);
        if (this.windows.get(component.instanceId) === record) {
          this.windows.delete(component.instanceId);
          if (!this.closing && !record.suppressRecovery) {
            try { this.onWindowClosed(component.instanceId, clone(record.component), record.closeReason || 'window closed'); } catch {}
          }
        }
      });
      // Keep the BrowserWindow listener for test doubles and older adapters;
      // Electron itself emits this event from webContents above.
      record.window.on('render-process-gone', handleRenderProcessGone);
      record.window.on('moved', () => this.handleMoved(record));
    }
    this.installNativeDragHooks(record);
    try {
      const loading = record.window.loadFile(this.pagePath);
      if (loading && typeof loading.catch === 'function') loading.catch(() => {});
    } catch {}
    if (this.hostService) this.startHost(record);
    return record;
  }

  installNativeDragHooks(record) {
    if (!this.hostService || typeof this.getCursorPoint !== 'function' || typeof record.window?.hookWindowMessage !== 'function') return;
    const hooks = [
      [WM_LBUTTONDOWN, () => this.handleNativeDragMessage(record, 'start')],
      [WM_MOUSEMOVE, () => this.handleNativeDragMessage(record, 'update')],
      [WM_LBUTTONUP, () => this.handleNativeDragMessage(record, 'end')],
      [WM_CAPTURECHANGED, () => this.handleNativeDragMessage(record, 'cancel')]
    ];
    for (const [message, callback] of hooks) {
      try {
        record.window.hookWindowMessage(message, callback);
        record.nativeDragHooks.push(message);
      } catch {}
    }
  }

  uninstallNativeDragHooks(record) {
    if (!record.nativeDragHooks.length || typeof record.window?.unhookWindowMessage !== 'function') return;
    for (const message of record.nativeDragHooks) {
      try { record.window.unhookWindowMessage(message); } catch {}
    }
    record.nativeDragHooks = [];
  }

  nativeDragPayload() {
    let point;
    try { point = this.getCursorPoint?.(); } catch { return undefined; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
    return { pointerId: NATIVE_POINTER_ID, x: point.x, y: point.y };
  }

  handleNativeDragMessage(record, operation) {
    if (record.hostMode !== 'desktop') return;
    if (operation === 'start') {
      if (record.nativeDrag || record.drag || !record.editing || !record.component.visible || !record.hostReady) return;
      const payload = this.nativeDragPayload();
      if (!payload) return;
      record.nativeDrag = true;
      const started = this.dispatchDrag(record.window.webContents, 'start', payload);
      record.nativeDragTask = Promise.resolve(started).then(async result => {
        if (!result?.ok) {
          record.nativeDrag = false;
          return result;
        }
        try {
          const captured = await this.hostService.capturePointer(record.component.instanceId);
          if (captured?.success !== true) {
            await this.dispatchDrag(record.window.webContents, 'cancel', payload);
            record.nativeDrag = false;
            return { ok: false, errorCode: 'POINTER_CAPTURE_FAILED' };
          }
        } catch {
          await this.dispatchDrag(record.window.webContents, 'cancel', payload);
          record.nativeDrag = false;
          return { ok: false, errorCode: 'POINTER_CAPTURE_FAILED' };
        }
        return result;
      }).catch(() => {
        record.nativeDrag = false;
        return { ok: false, errorCode: 'NATIVE_DRAG_FAILED' };
      });
      return;
    }
    if (!record.nativeDrag && !record.drag) return;
    const payload = this.nativeDragPayload();
    if (!payload) return;
    const task = record.nativeDragTask.then(async () => {
      const result = await this.dispatchDrag(record.window.webContents, operation, payload);
      if (operation === 'update' && result?.ok !== true && record.drag) await this.dispatchDrag(record.window.webContents, 'cancel', payload);
      if (operation === 'end' || operation === 'cancel') {
        try { await this.hostService.releasePointer(record.component.instanceId); } catch {}
        record.nativeDrag = false;
      }
      return result;
    }).catch(() => {
      record.nativeDrag = false;
      return { ok: false, errorCode: 'NATIVE_DRAG_FAILED' };
    });
    record.nativeDragTask = task;
  }

  hostDisplay(component) {
    return typeof this.hostTargetDisplay === 'function' ? this.hostTargetDisplay(component) : this.hostTargetDisplay;
  }

  notifyHostState(record, state) {
    try { this.onHostState(record.component.instanceId, clone(state)); } catch {}
  }

  setWindowMouseEvents(record, editing) {
    if (!this.isAlive(record.window) || typeof record.window.setIgnoreMouseEvents !== 'function') return;
    try {
      record.window.setIgnoreMouseEvents(!editing, { forward: !editing });
    } catch {
      try { record.window.setIgnoreMouseEvents(!editing); } catch {}
    }
  }

  queueHost(record, operation) {
    const task = record.hostTask.then(operation);
    record.hostTask = task.catch(() => {});
    return task;
  }

  startHost(record) {
    this.queueHost(record, async () => {
      try {
        const adapter = this.hostService.adapter;
        if (adapter && typeof adapter.registerWindow === 'function') adapter.registerWindow(record.component.instanceId, record.window);
        await this.hostService.create(record.component);
        let state;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            state = await this.hostService.attach(record.component.instanceId, this.hostDisplay(record.component));
          } catch (error) {
            if (attempt === 3) throw error;
            await new Promise(resolve => setTimeout(resolve, 400));
            continue;
          }
          record.hostPhase = state?.phase || 'unavailable';
          record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
          this.notifyHostState(record, state);
          if (record.hostReady || attempt === 3) break;
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        if (record.hostReady) {
          const interactive = this.isInteractive(record);
          const state = await this.hostService.setInputMode(record.component.instanceId, this.inputMode(record));
          if (!this.hostInputSucceeded(state)) throw new Error('host input mode was not applied');
          this.setWindowMouseEvents(record, interactive);
          if (!this.temporaryHidden && record.component.visible && record.loaded && this.isAlive(record.window) && typeof record.window.show === 'function') record.window.show();
        } else if (this.isAlive(record.window) && typeof record.window.hide === 'function') {
          record.window.hide();
        }
      } catch (error) {
        record.hostReady = false;
        record.hostPhase = 'unavailable';
        this.notifyHostState(record, { phase: record.hostPhase, lastError: 'host initialization failed' });
        if (this.isAlive(record.window) && typeof record.window.hide === 'function') record.window.hide();
        throw error;
      }
    });
  }

  handleMoved(record) {
    if (record.drag) return;
    if (!this.isAlive(record.window) || !record.editing || !record.component.visible || typeof record.window.getPosition !== 'function') return;
    let position;
    try { position = record.window.getPosition(); } catch { return; }
    if (!Array.isArray(position) || position.length < 2 || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) return;
    const [x, y] = position;
    if (x === record.component.bounds.x && y === record.component.bounds.y) return;
    const previous = clone(record.component);
    const moved = clone(record.component);
    moved.bounds = { ...moved.bounds, x, y };
    record.component = moved;
    const sequence = ++record.moveSequence;
    Promise.resolve(this.onMove(moved.instanceId, { x, y }, { editing: record.editing })).then(async result => {
      if (record.moveSequence !== sequence || !result) return;
      // The native window is already at the user's released position. Updating
      // it again here can re-apply a stale snapshot and make it appear to snap
      // back, especially while an async config write is completing.
      record.component = clone(result);
      if (this.hostService && record.hostMode === 'desktop' && record.hostReady) {
        await this.hostService.setGeometry(record.component.instanceId, record.component.bounds);
      }
      if (record.loaded) this.sendCurrent(record);
    }).catch(() => {
      if (record.moveSequence === sequence) this.updateRecord(record, previous);
    });
  }

  findRecordBySender(sender) {
    for (const record of this.windows.values()) if (record.window?.webContents === sender) return record;
    return undefined;
  }

  updateComponentRecord(instanceId, component, settings) {
    const record = this.windows.get(instanceId);
    if (!record) return false;
    record.component = resolveComponent(component, settings);
    this.sendCurrent(record);
    return true;
  }

  requestNoteFlush(timeoutMs = 4000) {
    const requests = [];
    for (const record of this.windows.values()) {
      if (record.component.type !== 'note' || !record.loaded || !this.isAlive(record.window) || !record.window.webContents?.send) continue;
      const requestId = `note-flush-${Date.now()}-${++this.noteFlushSequence}`;
      requests.push(new Promise(resolve => {
        const timer = setTimeout(() => {
          record.noteFlushes.delete(requestId);
          resolve({ ok: false, errorCode: 'NOTE_FLUSH_TIMEOUT' });
        }, timeoutMs);
        record.noteFlushes.set(requestId, result => {
          clearTimeout(timer);
          record.noteFlushes.delete(requestId);
          resolve(result?.ok === true ? { ok: true } : { ok: false, errorCode: result?.errorCode || 'NOTE_SAVE_FAILED' });
        });
        this.send(record, 'widget:flush-note', { requestId });
      }));
    }
    return Promise.all(requests);
  }

  completeNoteFlush(sender, requestId, result) {
    if (typeof requestId !== 'string') return false;
    const record = this.findRecordBySender(sender);
    const resolve = record?.noteFlushes?.get(requestId);
    if (!resolve) return false;
    resolve(result);
    return true;
  }

  validDragPayload(payload) {
    return payload && typeof payload === 'object' && Number.isInteger(payload.pointerId) && Number.isFinite(payload.x) && Number.isFinite(payload.y);
  }

  async dispatchDrag(sender, operation, payload) {
    const record = this.findRecordBySender(sender);
    if (!record || !['start', 'update', 'end', 'cancel'].includes(operation) || !this.validDragPayload(payload)) return { ok: false, errorCode: 'INVALID_DRAG' };
    if (!record.editing || !record.component.visible || (record.hostMode === 'desktop' && !record.hostReady)) return { ok: false, errorCode: 'DRAG_NOT_ALLOWED' };
    if (operation === 'start') {
      if (record.drag) return { ok: false, errorCode: 'DRAG_IN_PROGRESS' };
      record.drag = { pointerId: payload.pointerId, startPoint: { x: payload.x, y: payload.y }, startBounds: clone(record.component.bounds), latestBounds: clone(record.component.bounds) };
      return { ok: true, bounds: clone(record.component.bounds) };
    }
    if (!record.drag || record.drag.pointerId !== payload.pointerId) return { ok: false, errorCode: 'STALE_DRAG' };
    if (operation === 'cancel') {
      const previous = record.drag.startBounds;
      record.drag = undefined;
      this.updateRecord(record, { ...record.component, bounds: previous });
      return { ok: true, cancelled: true, bounds: clone(previous) };
    }
    const nextBounds = {
      ...record.drag.startBounds,
      x: record.drag.startBounds.x + payload.x - record.drag.startPoint.x,
      y: record.drag.startBounds.y + payload.y - record.drag.startPoint.y,
      unit: 'dip'
    };
    record.drag.latestBounds = nextBounds;
    record.component = { ...record.component, bounds: nextBounds };
    try {
      if (this.hostService && record.hostMode === 'desktop') {
        await this.queueHost(record, async () => {
          const state = await this.hostService.setGeometry(record.component.instanceId, nextBounds);
          record.hostPhase = state?.phase || record.hostPhase;
          record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
          this.notifyHostState(record, state);
        });
      } else if (this.isAlive(record.window) && typeof record.window.setBounds === 'function') {
        record.window.setBounds(toWindowBounds(nextBounds));
      }
    } catch {
      return { ok: false, errorCode: 'DRAG_GEOMETRY_FAILED' };
    }
    if (operation === 'update') return { ok: true, bounds: clone(nextBounds) };

    const previous = { ...record.component, bounds: clone(record.drag.startBounds) };
    const finalPosition = { x: nextBounds.x, y: nextBounds.y };
    record.drag = undefined;
    try {
      const result = await this.onMove(record.component.instanceId, finalPosition);
      if (!result) throw new Error('position persistence returned no component');
      record.component = clone(result);
      if (this.hostService && record.hostMode === 'desktop' && record.hostReady) await this.hostService.setGeometry(record.component.instanceId, record.component.bounds);
      if (record.loaded) this.sendCurrent(record);
      return { ok: true, bounds: clone(record.component.bounds) };
    } catch {
      record.component = previous;
      if (this.hostService && record.hostMode === 'desktop' && record.hostReady) this.queueHost(record, async () => { await this.hostService.setGeometry(record.component.instanceId, previous.bounds); }).catch(() => {});
      else if (this.isAlive(record.window) && typeof record.window.setBounds === 'function') record.window.setBounds(toWindowBounds(previous.bounds));
      if (record.loaded) this.sendCurrent(record);
      return { ok: false, errorCode: 'DRAG_PERSIST_FAILED', bounds: clone(previous.bounds) };
    }
  }

  async dispatchDragFromCursor(sender, operation, pointerId) {
    if (!Number.isInteger(pointerId)) return { ok: false, errorCode: 'INVALID_DRAG' };
    let point;
    try { point = this.getCursorPoint?.(); } catch { point = undefined; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, errorCode: 'CURSOR_UNAVAILABLE' };
    return this.dispatchDrag(sender, operation, { pointerId, x: point.x, y: point.y });
  }

  updateRecord(record, component) {
    record.component = clone(component);
    if (this.hostService && record.hostMode === 'desktop' && record.hostReady) {
      this.queueHost(record, async () => {
        const state = await this.hostService.setGeometry(component.instanceId, component.bounds);
        record.hostPhase = state?.phase || record.hostPhase;
        record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
        this.notifyHostState(record, state);
      }).catch(() => {});
    } else if (this.isAlive(record.window) && typeof record.window.setBounds === 'function') {
      record.window.setBounds(toWindowBounds(component.bounds));
    }
    if (record.loaded) {
      this.sendCurrent(record);
      if (component.visible && record.hostReady && !this.temporaryHidden && typeof record.window.show === 'function') record.window.show();
      if ((!component.visible || this.temporaryHidden) && typeof record.window.hide === 'function') record.window.hide();
    }
  }

  async setTodoInteraction(instanceId, interactive) {
    const record = this.windows.get(instanceId);
    if (!record || record.component.type !== 'daily-todo' || typeof interactive !== 'boolean') return { ok: false, errorCode: 'INVALID_TODO_INTERACTION' };
    const previous = record.todoInteractive !== false;
    const next = interactive;
    record.todoInteractive = next;
    const apply = async () => {
      if (this.hostService && record.hostMode === 'desktop' && record.hostReady) {
        const state = await this.hostService.setInputMode(instanceId, this.inputMode(record));
        if (!this.hostInputSucceeded(state)) throw new Error('host input mode was not applied');
        record.hostPhase = state?.phase || record.hostPhase;
        record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
        this.notifyHostState(record, state);
      }
      this.setWindowMouseEvents(record, this.isInteractive(record));
      this.send(record, 'widget:edit-mode', this.editModePayload(record));
    };
    try {
      if (this.hostService && record.hostMode === 'desktop' && record.hostReady) await this.queueHost(record, apply);
      else await apply();
      return { ok: true, interactive: next };
    } catch {
      record.todoInteractive = previous;
      try {
        if (this.hostService && record.hostMode === 'desktop' && record.hostReady) {
          await this.queueHost(record, async () => {
            const state = await this.hostService.setInputMode(instanceId, this.inputMode(record));
            if (!this.hostInputSucceeded(state)) throw new Error('host input mode restore was not applied');
            record.hostPhase = state?.phase || record.hostPhase;
            record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
            this.notifyHostState(record, state);
          });
        }
      } catch {}
      this.setWindowMouseEvents(record, this.isInteractive(record));
      this.send(record, 'widget:edit-mode', this.editModePayload(record));
      return { ok: false, errorCode: 'TODO_INTERACTION_FAILED' };
    }
  }

  setEditMode(instanceId, editing) {
    const record = this.windows.get(instanceId);
    if (!record) return false;
    const nextEditing = Boolean(editing);
    const canSwitchHost = Boolean(this.hostService && typeof this.hostService.detach === 'function' && typeof this.hostService.attach === 'function');
    record.editing = nextEditing;
    if (!record.editing) record.moveSequence += 1;
    if (!record.editing && (record.drag || record.nativeDrag)) {
      record.drag = undefined;
      record.nativeDrag = false;
      if (this.hostService && typeof this.hostService.releasePointer === 'function') this.hostService.releasePointer(instanceId).catch(() => {});
    }
    if (!record.editing && canSwitchHost && record.hostMode === 'floating') {
      if (this.isAlive(record.window) && typeof record.window.setMovable === 'function') record.window.setMovable(false);
      this.setWindowMouseEvents(record, false);
      this.send(record, 'widget:edit-mode', this.editModePayload(record));
      this.queueHost(record, async () => {
        const attached = await this.hostService.attach(instanceId, this.hostDisplay(record.component));
        record.hostPhase = attached?.phase || 'unavailable';
        record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
        if (!record.hostReady) {
          this.notifyHostState(record, attached);
          if (this.isAlive(record.window) && typeof record.window.hide === 'function') record.window.hide();
          return;
        }
        const state = await this.hostService.setInputMode(instanceId, this.inputMode(record));
        if (!this.hostInputSucceeded(state)) throw new Error('host input mode was not applied');
        record.hostPhase = state?.phase || record.hostPhase;
        record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
        record.hostMode = record.hostReady ? 'desktop' : 'floating';
        this.notifyHostState(record, state);
        this.setWindowMouseEvents(record, this.isInteractive(record));
        this.send(record, 'widget:edit-mode', this.editModePayload(record));
        if (record.hostReady && !this.temporaryHidden && record.component.visible && record.loaded && this.isAlive(record.window) && typeof record.window.show === 'function') record.window.show();
      }).catch(error => {
        record.hostReady = false;
        record.hostPhase = 'unavailable';
        this.notifyHostState(record, { phase: record.hostPhase, lastError: 'host reattach failed' });
        if (this.isAlive(record.window) && typeof record.window.hide === 'function') record.window.hide();
      });
      return true;
    }
    if (record.editing && canSwitchHost && record.hostMode === 'desktop' && record.hostReady) {
      this.queueHost(record, async () => {
        const detached = await this.hostService.detach(instanceId);
        record.hostMode = 'floating';
        record.hostPhase = 'floating';
        record.hostReady = true;
        if (this.isAlive(record.window) && typeof record.window.setBounds === 'function') record.window.setBounds(toWindowBounds(record.component.bounds));
        if (this.isAlive(record.window) && typeof record.window.setMovable === 'function') record.window.setMovable(true);
        this.setWindowMouseEvents(record, true);
        if (!this.temporaryHidden && record.component.visible && record.loaded && this.isAlive(record.window) && typeof record.window.show === 'function') record.window.show();
        this.send(record, 'widget:edit-mode', this.editModePayload(record));
        return detached;
      }).catch(() => {
        record.hostReady = false;
        record.hostPhase = 'unavailable';
        this.notifyHostState(record, { phase: record.hostPhase, lastError: 'host detach failed' });
      });
      return true;
    }
    if (this.isAlive(record.window) && typeof record.window.setMovable === 'function') record.window.setMovable(record.editing);
    this.send(record, 'widget:edit-mode', this.editModePayload(record));
    if (this.hostService && record.hostMode === 'desktop' && record.hostReady) {
      this.queueHost(record, async () => {
        const interactive = this.isInteractive(record);
        const state = await this.hostService.setInputMode(instanceId, this.inputMode(record));
        if (!this.hostInputSucceeded(state)) throw new Error('host input mode was not applied');
        record.hostPhase = state?.phase || record.hostPhase;
        record.hostReady = ['ready', 'editing'].includes(record.hostPhase);
        this.notifyHostState(record, state);
        // Electron's mouse-ignore flag must be applied after the native
        // WS_EX_* transition, otherwise the two APIs can restore opposing
        // input styles on a reparented WorkerW child.
        this.setWindowMouseEvents(record, interactive);
      }).catch(() => {});
    }
    return true;
  }

  setTemporaryHidden(hidden, snapshot) {
    const nextHidden = Boolean(hidden);
    if (nextHidden) {
      if (!this.temporaryHidden) {
        this.temporarilyVisibleIds = new Set((snapshot?.catalog?.components || []).filter(component => component.visible).map(component => component.instanceId));
      }
      this.temporaryHidden = true;
      for (const record of this.windows.values()) {
        if (this.isAlive(record.window) && typeof record.window.hide === 'function') record.window.hide();
      }
      return;
    }
    if (!this.temporaryHidden) return;
    const restoreIds = this.temporarilyVisibleIds;
    this.temporaryHidden = false;
    this.temporarilyVisibleIds = new Set();
    const current = new Map((snapshot?.catalog?.components || []).map(component => [component.instanceId, component]));
    for (const instanceId of restoreIds) {
      const record = this.windows.get(instanceId);
      const component = current.get(instanceId);
      if (record && component?.visible && record.hostReady && this.isAlive(record.window) && typeof record.window.show === 'function') record.window.show();
    }
  }

  isTemporarilyHidden() {
    return this.temporaryHidden;
  }

  sync(snapshot) {
    const components = Array.isArray(snapshot?.catalog?.components) ? snapshot.catalog.components : [];
    const settings = snapshot?.catalog?.settings || {};
    const componentIds = new Set(components.map(component => component.instanceId));
    for (const rawComponent of components) {
      const component = resolveComponent(rawComponent, settings);
      let record = this.windows.get(component.instanceId);
      if (component.visible) {
        if (!record) record = this.createRecord(component);
        else this.updateRecord(record, component);
      } else if (record && this.isAlive(record.window) && typeof record.window.hide === 'function') {
        record.component = clone(component);
        record.window.hide();
      }
    }
    for (const [instanceId, record] of this.windows) {
      if (componentIds.has(instanceId)) continue;
      record.suppressRecovery = true;
      if (this.hostService) {
        this.queueHost(record, async () => {
          await this.hostService.destroy(instanceId);
          if (this.isAlive(record.window) && typeof record.window.close === 'function') record.window.close();
        }).catch(() => { if (this.isAlive(record.window) && typeof record.window.close === 'function') record.window.close(); });
      } else if (this.isAlive(record.window) && typeof record.window.close === 'function') record.window.close();
      else this.windows.delete(instanceId);
    }
  }

  publishMetrics(metrics) {
    this.latestMetrics = clone(metrics);
    for (const record of this.windows.values()) this.send(record, 'widget:metrics', this.latestMetrics);
  }

  publishCodexQuota(quota) {
    this.latestCodexQuota = clone(quota);
    for (const record of this.windows.values()) this.send(record, 'widget:codex-quota', this.latestCodexQuota);
  }

  closeAll() {
    this.closing = true;
    for (const record of this.windows.values()) {
      if (this.hostService) {
        this.queueHost(record, async () => {
          await this.hostService.destroy(record.component.instanceId);
          if (this.isAlive(record.window) && typeof record.window.close === 'function') record.window.close();
        }).catch(() => { if (this.isAlive(record.window) && typeof record.window.close === 'function') record.window.close(); });
      } else if (this.isAlive(record.window) && typeof record.window.close === 'function') record.window.close();
    }
    this.windows.clear();
  }
}

module.exports = { WidgetWindowService, buildWidgetWindowOptions, resolveComponent, toWindowBounds };
