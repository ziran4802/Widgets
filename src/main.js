const { app, BrowserWindow, ipcMain, screen } = require('electron');

const probeMode = process.argv.includes('--probe') || process.argv.includes('--auto-attach');
if (!probeMode) {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    const manager = require('./manager-main');
    app.on('second-instance', (_event, commandLine) => {
      manager.handleSecondInstance(commandLine);
    });
  }
} else {
const path = require('node:path');
const { loadNativeHostAdapter } = require('./native-host');
const { classifyObservation, RESULT } = require('./m0-contract');
const { appendJsonLine, createProbeRunId, safeValue, sanitizeReason } = require('./diagnostics');
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 160;
const DEFAULT_MARGIN = 16;
const reportFile = process.env.WIDGET_M0_REPORT || path.join(process.cwd(), 'diagnostics', 'm0-probe.jsonl');
const runId = createProbeRunId();
const host = loadNativeHostAdapter({ disableNative: process.env.WIDGET_M0_DISABLE_NATIVE === '1' });
let controlWindow;
let probeWindow;
let quitting = false;
let reportClosed = false;
let state = {
  runId,
  phase: 'booting',
  attached: false,
  mode: 'locked',
  bounds: undefined,
  scaleFactor: undefined,
  capability: { available: host.available === true, nativeAvailable: host.nativeAvailable === true, reason: host.nativeReason || '' },
  lastResult: undefined,
  hostState: undefined,
  records: []
};

function snapshot() {
  return safeValue({ ...state, records: state.records.slice(-20) });
}

function publish() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.webContents.send('m0:state', snapshot());
}

function record(operation, raw) {
  const classification = classifyObservation(raw);
  const entry = { runId, at: new Date().toISOString(), operation, result: classification.result, reasons: classification.reasons, observation: raw };
  state.lastResult = { operation, result: classification.result, reasons: classification.reasons };
  state.records.push(entry);
  try { appendJsonLine(reportFile, entry); } catch (error) { state.lastResult = { operation: 'diagnostics', result: RESULT.FAIL, reasons: [`diagnostics write failed: ${sanitizeReason(error.message)}`] }; }
  publish();
  return { ...raw, classification };
}

function layout() {
  const display = screen.getPrimaryDisplay();
  const work = display.workArea;
  const scaleFactor = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const bounds = { x: work.x + work.width - DEFAULT_WIDTH - DEFAULT_MARGIN, y: work.y + DEFAULT_MARGIN, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, unit: 'dip' };
  state.bounds = bounds;
  state.scaleFactor = scaleFactor;
  return { bounds, scaleFactor };
}

async function command(name) {
  if (name === 'attach') {
    if (!probeWindow || probeWindow.isDestroyed()) return record('attach', { nativeAvailable: false, success: false, errors: ['probe window unavailable'] });
    const { bounds, scaleFactor } = layout();
    if (state.attached && state.hostState) {
      const observation = host.observe(probeWindow, state.hostState, bounds, scaleFactor, state.mode, 'attach');
      return record('attach', { ...observation, alreadyAttached: true });
    }
    const result = host.attach(probeWindow, bounds, scaleFactor);
    state.hostState = result;
    state.attached = result.success === true;
    state.mode = 'locked';
    if (state.attached) probeWindow.showInactive();
    return record('attach', result);
  }
  if (name === 'observe') {
    const { bounds, scaleFactor } = layout();
    const result = host.observe(probeWindow, state.hostState, bounds, scaleFactor, state.mode, 'validate');
    return record('validate', result);
  }
  if (name === 'editing' || name === 'locked') {
    const { bounds } = layout();
    const result = host.setInputMode(probeWindow, state.hostState, name, bounds);
    state.mode = name;
    return record('input', result);
  }
  if (name === 'geometry') {
    const { bounds } = layout();
    const result = host.setGeometry(probeWindow, state.hostState, bounds);
    state.hostState = { ...state.hostState, ...result };
    return record('geometry', result);
  }
  if (name === 'sample-hit') {
    const { bounds, scaleFactor } = layout();
    const point = { x: Math.round((bounds.x + bounds.width / 2) * scaleFactor), y: Math.round((bounds.y + bounds.height / 2) * scaleFactor) };
    return record('input-hit', host.samplePoint(probeWindow, point));
  }
  if (name === 'restore') {
    const result = host.restore(probeWindow, state.hostState || {});
    if (result.success === true) {
      state.attached = false;
      state.hostState = undefined;
      state.mode = 'locked';
      if (probeWindow && !probeWindow.isDestroyed()) probeWindow.hide();
    }
    return record('restore', result);
  }
  if (name === 'exit') {
    await shutdown();
    return { ok: true };
  }
  return { ok: false, error: 'unknown command' };
}

function isControlEvent(event) {
  return Boolean(controlWindow && event.sender === controlWindow.webContents);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (state.attached && probeWindow && !probeWindow.isDestroyed()) {
    const result = host.restore(probeWindow, state.hostState || {});
    record('restore-on-exit', result);
  }
  if (probeWindow && !probeWindow.isDestroyed()) probeWindow.close();
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.close();
  if (!reportClosed) {
    reportClosed = true;
    try { appendJsonLine(reportFile, { runId, at: new Date().toISOString(), operation: 'run-complete', result: 'RECORDED', phase: state.phase, records: state.records.length }); } catch {}
  }
  app.quit();
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 680,
    height: 820,
    minWidth: 560,
    minHeight: 680,
    show: true,
    title: 'Widget M0 Host Probe',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  controlWindow.loadFile(path.join(__dirname, 'control.html'));
  controlWindow.on('closed', () => { controlWindow = undefined; if (!quitting) void shutdown(); });
}

function createProbeWindow() {
  probeWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#184682',
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  probeWindow.loadFile(path.join(__dirname, 'probe.html'));
  probeWindow.on('closed', () => { probeWindow = undefined; state.attached = false; publish(); });
}

app.whenReady().then(() => {
  appendJsonLine(reportFile, { runId, at: new Date().toISOString(), operation: 'capability', result: host.available ? 'READY' : RESULT.INCONCLUSIVE, capability: state.capability });
  createProbeWindow();
  createControlWindow();
  state.phase = 'ready';
  publish();
  if (process.argv.includes('--auto-attach')) setTimeout(() => void command('attach'), 1200);
  const autoExitMs = Number(process.env.WIDGET_M0_AUTO_EXIT_MS || 0);
  if (Number.isFinite(autoExitMs) && autoExitMs > 0) setTimeout(() => void shutdown(), autoExitMs);
}).catch(error => {
  state.phase = 'failed';
  record('startup', { nativeAvailable: host.nativeAvailable === true, success: false, errors: [sanitizeReason(error.message)] });
  void shutdown();
});

ipcMain.handle('m0:get-state', event => isControlEvent(event) ? snapshot() : undefined);
ipcMain.handle('m0:command', async (event, name) => {
  if (!isControlEvent(event) || typeof name !== 'string' || !['attach', 'observe', 'editing', 'locked', 'geometry', 'sample-hit', 'restore', 'exit'].includes(name)) return { ok: false, error: 'unauthorized command' };
  return command(name);
});

app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
app.on('window-all-closed', event => event.preventDefault());
}
