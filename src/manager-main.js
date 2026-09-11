const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AppService } = require('./app-service');
const { ConfigStore } = require('./config-store');
const { HostService } = require('./host-service');
const { ManagerIpcRouter } = require('./manager-ipc');
const { MetricsService } = require('./metrics-service');
const { buildWidgetWindowOptions, WidgetWindowService } = require('./widget-window-service');
const { loadNativeHostAdapter } = require('./native-host');
const { WorkerWHostAdapter } = require('./workerw-host-adapter');
const { appendJsonLine, sanitizeReason } = require('./diagnostics');
const { OperationQueue, secondInstanceAction } = require('./manager-lifecycle');
const { TrayService } = require('./tray-service');
const { AutostartService } = require('./autostart-service');
const { createWidgetNativeImage } = require('./widget-icon');
const { CodexQuotaService } = require('./codex-quota-service');

const reportFile = path.resolve(process.env.WIDGET_M1_REPORT || path.join(process.cwd(), 'diagnostics', 'm1-manager.jsonl'));
let managerWindow;
let service;
let router;
let metrics;
let widgetWindows;
let moveTail = Promise.resolve();
let activeEditInstanceId;
let activeEditSessionId;
let quitting = false;
let reportClosed = false;
let shutdownPromise;
let closeRequestPromise;
let pendingManagerFocus = false;
let trayService;
let noteFailureInjectionUsed = false;
let codexQuota;
let hostService;
const silentAutostart = process.argv.includes('--autostart') || process.argv.includes('--silent-autostart');
const operationQueue = new OperationQueue();
let autostartService;

function report(operation, value) {
  try { appendJsonLine(reportFile, { at: new Date().toISOString(), operation, ...value }); } catch {}
}

async function captureManagerScreenshots() {
  const outputDir = process.env.WIDGET_M1_TEST_MANAGER_SCREENSHOT_DIR;
  if (!outputDir || !managerWindow?.webContents?.capturePage) return;
  const original = managerWindow.getBounds();
  const files = [];
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const [width, height] of [[1120, 800], [800, 640]]) {
      managerWindow.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 220));
      const image = await managerWindow.webContents.capturePage();
      const file = path.join(outputDir, `manager-${width}x${height}.png`);
      fs.writeFileSync(file, image.toPNG());
      files.push(file);
    }
  } catch (error) {
    report('manager-ui-screenshots', { result: 'FAIL', reason: sanitizeReason(error.message) });
  } finally {
    managerWindow.setSize(original.width, original.height);
  }
  if (files.length === 2) report('manager-ui-screenshots', { result: 'PASS', files });
}

function createManagerWindow() {
  managerWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 800,
    minHeight: 640,
    show: !silentAutostart,
    title: 'Widget 管理器',
    autoHideMenuBar: true,
    icon: createWidgetNativeImage(nativeImage),
    webPreferences: {
      preload: path.join(__dirname, 'manager-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  managerWindow.setMenuBarVisibility(false);
  report('manager-window', { result: silentAutostart ? 'HIDDEN_SILENT_AUTOSTART' : 'VISIBLE_MANUAL_START' });
  managerWindow.loadFile(path.join(__dirname, 'manager.html'));
  managerWindow.on('close', event => {
    if (quitting) return;
    if (trayService?.isReady()) {
      event.preventDefault();
      void (activeEditSessionId ? requestHideToTray() : hideManagerToTray());
      return;
    }
    event.preventDefault();
    void requestExit('manager-close');
  });
  managerWindow.on('closed', () => {
    managerWindow = undefined;
    if (!quitting) report('manager-window', { result: 'CLOSED_WITHOUT_EXIT' });
  });
  if (pendingManagerFocus) {
    pendingManagerFocus = false;
    focusManagerWindow();
  }
}

function isAlive(window) {
  return Boolean(window && (typeof window.isDestroyed !== 'function' || !window.isDestroyed()));
}

function focusManagerWindow() {
  if (!isAlive(managerWindow)) {
    pendingManagerFocus = true;
    return false;
  }
  if (managerWindow.isMinimized?.()) managerWindow.restore();
  if (managerWindow.isVisible?.() === false) managerWindow.show();
  managerWindow.focus();
  return true;
}

function handleSecondInstance(commandLine) {
  const action = secondInstanceAction(commandLine);
  report('second-instance', { result: action === 'focus' ? 'FOCUSED' : 'IGNORED_SILENT_AUTOSTART', action });
  if (action === 'focus') focusManagerWindow();
  return action;
}

function createTrayIcon() {
  return createWidgetNativeImage(nativeImage);
}

function notifyTrayActionBlocked() {
  focusManagerWindow();
  void dialog.showMessageBox(managerWindow, {
    type: 'info',
    buttons: ['返回编辑'],
    title: '当前正在编辑布局',
    message: '请先完成或取消当前编辑',
    detail: '托盘操作不会绕过未保存布局事务。'
  });
}

function hideManagerToTray() {
  if (!isAlive(managerWindow) || !trayService?.isReady()) return false;
  managerWindow.hide();
  report('manager-window', { result: 'HIDDEN_TO_TRAY' });
  return true;
}

function toggleTemporaryComponents(hidden) {
  if (activeEditSessionId) {
    notifyTrayActionBlocked();
    return false;
  }
  const snapshot = service.snapshot();
  widgetWindows.setTemporaryHidden(hidden, snapshot);
  trayService?.setComponentsHidden(hidden);
  report('components-temporary-visibility', { result: hidden ? 'HIDDEN' : 'RESTORED' });
  return true;
}

function openManagerFromTray() {
  focusManagerWindow();
}

function editLayoutFromTray() {
  focusManagerWindow();
}

function settingsFromTray() {
  focusManagerWindow();
}

function createTrayRuntime() {
  trayService = new TrayService({
    Tray,
    Menu,
    icon: createTrayIcon(),
    onOpen: openManagerFromTray,
    onToggleComponents: toggleTemporaryComponents,
    onToggleTodoInteraction: toggleTodoInteractionFromTray,
    onEditLayout: editLayoutFromTray,
    onSettings: settingsFromTray,
    onExit: () => { void requestExit('tray-exit'); },
    onError: error => report('tray', { result: 'FAIL', reason: sanitizeReason(error?.message || 'tray unavailable') })
  });
  const ready = trayService.start();
  report('tray', { result: ready ? 'READY' : 'FAIL' });
  return ready;
}

function scheduleTraySmokeTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_TRAY_HIDE_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  setTimeout(() => {
    if (quitting) return;
    if (!trayService?.isReady()) {
      report('tray-test', { result: 'FAIL', reason: 'tray unavailable' });
      return;
    }
    const hidden = hideManagerToTray();
    report('tray-test', { result: hidden ? 'PASS' : 'FAIL' });
  }, delayMs);
}

function createWidgetRuntime() {
  const useDesktopHost = process.platform === 'win32' && process.env.WIDGET_M1_HOST_MODE !== 'floating';
  if (useDesktopHost) {
    const nativeHost = loadNativeHostAdapter({ disableNative: process.env.WIDGET_M0_DISABLE_NATIVE === '1' });
    const getDisplay = targetDisplay => {
      if (targetDisplay === 'primary') return screen.getPrimaryDisplay();
      return screen.getAllDisplays().find(display => String(display.id) === String(targetDisplay)) || screen.getPrimaryDisplay();
    };
    const hostAdapter = new WorkerWHostAdapter({
      nativeHost,
      createWindow: (instance, bounds) => new BrowserWindow(buildWidgetWindowOptions({ ...instance, bounds }, path.join(__dirname, 'widget-preload.js'))),
      getDisplay
    });
    hostService = new HostService({ adapter: hostAdapter });
    report('host-capability', {
      result: nativeHost.available ? 'READY' : 'UNAVAILABLE',
      hostMode: 'desktop',
      nativeAvailable: nativeHost.nativeAvailable === true,
      reason: nativeHost.nativeReason
    });
  } else {
    hostService = undefined;
    report('host-capability', { result: 'DISABLED', hostMode: 'floating', nativeAvailable: false, reason: 'floating mode explicitly requested for diagnostics' });
  }
  widgetWindows = new WidgetWindowService({
    createWindow: options => new BrowserWindow(options),
    preloadPath: path.join(__dirname, 'widget-preload.js'),
    pagePath: path.join(__dirname, 'widget.html'),
    onMove: persistWidgetMove,
    onWindowClosed: recoverWidgetWindow,
    hostService,
    hostTargetDisplay: 'primary',
    onHostState: (instanceId, state) => {
      const errors = Array.isArray(state?.lastResult?.errors) ? state.lastResult.errors.slice(0, 4) : undefined;
      report('component-host', { result: state?.phase === 'ready' || state?.phase === 'editing' ? 'READY' : 'UNAVAILABLE', instanceId, phase: state?.phase, ...(errors?.length ? { errors } : {}) });
    },
    getCursorPoint: hostService ? () => screen.getCursorScreenPoint() : undefined
  });
  metrics = new MetricsService();
  metrics.on('update', snapshot => widgetWindows.publishMetrics(snapshot));
  let fixture;
  if (process.env.WIDGET_M1_TEST_CODEX_QUOTA) {
    try { fixture = JSON.parse(process.env.WIDGET_M1_TEST_CODEX_QUOTA); } catch { report('codex-quota-test', { result: 'FAIL', reason: 'invalid test fixture' }); }
  }
  codexQuota = new CodexQuotaService({ fixture });
  codexQuota.on('update', snapshot => widgetWindows.publishCodexQuota(snapshot));
}

function currentComponent(instanceId) {
  return service?.snapshot()?.catalog?.components?.find(component => component.instanceId === instanceId);
}

function noteSaveFailure(code = 'NOTE_SAVE_FAILED') {
  return { schemaVersion: 1, ok: false, errorCode: code, message: '便签保存失败，请重试' };
}

function todoSaveFailure(code = 'TODO_SAVE_FAILED') {
  return { schemaVersion: 1, ok: false, errorCode: code, message: '待办保存失败，请重试' };
}

function todoInteractionFailure(code = 'TODO_INTERACTION_FAILED') {
  return { schemaVersion: 1, ok: false, errorCode: code, message: '待办交互状态切换失败，请重试' };
}

async function saveNoteFromWidget(event, payload) {
  if (quitting) return noteSaveFailure('APP_EXITING');
  const record = widgetWindows?.findRecordBySender(event.sender);
  if (!record || record.component.type !== 'note') return noteSaveFailure('UNAUTHORIZED_SENDER');
  try {
    return await operationQueue.enqueue(async () => {
      try {
        if (process.env.WIDGET_M1_TEST_NOTE_FAIL_ONCE === '1' && !noteFailureInjectionUsed) {
          noteFailureInjectionUsed = true;
          return noteSaveFailure('CONFIG_WRITE_FAILED');
        }
        const component = await service.updateNoteContent(record.component.instanceId, payload);
        widgetWindows.updateComponentRecord(record.component.instanceId, component, service.snapshot().catalog.settings);
        if (process.env.WIDGET_M1_TEST_NOTE_EDIT_MS) report('note-save-test', { result: 'SAVED', instanceId: record.component.instanceId });
        return { schemaVersion: 1, ok: true, component };
      } catch {
        return noteSaveFailure();
      }
    });
  } catch {
    return noteSaveFailure('APP_EXITING');
  }
}

async function saveTodoFromWidget(event, payload) {
  if (quitting) return todoSaveFailure('APP_EXITING');
  if (event?.senderFrame !== event?.sender?.mainFrame) return todoSaveFailure('UNAUTHORIZED_SENDER');
  const record = widgetWindows?.findRecordBySender(event.sender);
  if (!record || record.component.type !== 'daily-todo') return todoSaveFailure('UNAUTHORIZED_SENDER');
  try {
    return await operationQueue.enqueue(async () => {
      try {
        const component = await service.updateTodoItems(record.component.instanceId, payload);
        widgetWindows.updateComponentRecord(record.component.instanceId, component, service.snapshot().catalog.settings);
        if (process.env.WIDGET_M1_TEST_TODO_MS) report('todo-save-test', { result: 'SAVED', instanceId: record.component.instanceId });
        return { schemaVersion: 1, ok: true, component };
      } catch {
        return todoSaveFailure();
      }
    });
  } catch {
    return todoSaveFailure('APP_EXITING');
  }
}

async function setTodoInteractionFromWidget(event, interactive) {
  if (quitting) return todoInteractionFailure('APP_EXITING');
  if (event?.senderFrame !== event?.sender?.mainFrame) return todoInteractionFailure('UNAUTHORIZED_SENDER');
  if (typeof interactive !== 'boolean') return todoInteractionFailure('INVALID_TODO_INTERACTION');
  const record = widgetWindows?.findRecordBySender(event.sender);
  if (!record || record.component.type !== 'daily-todo') return todoInteractionFailure('UNAUTHORIZED_SENDER');
  try {
    const result = await operationQueue.enqueue(() => widgetWindows.setTodoInteraction(record.component.instanceId, interactive));
    if (result?.ok !== true) return todoInteractionFailure(result?.errorCode);
    trayService?.setTodoInteractionState(result.interactive === true);
    return { schemaVersion: 1, ok: true, interactive: result.interactive === true };
  } catch {
    return todoInteractionFailure();
  }
}

async function toggleTodoInteractionFromTray(interactive) {
  if (activeEditSessionId) {
    notifyTrayActionBlocked();
    return false;
  }
  if (typeof interactive !== 'boolean') return false;
  const record = [...(widgetWindows?.windows?.values() || [])].find(candidate => candidate.component.type === 'daily-todo');
  if (!record) {
    report('todo-interaction', { result: 'FAIL', reason: 'daily todo window unavailable' });
    return false;
  }
  try {
    const result = await operationQueue.enqueue(() => widgetWindows.setTodoInteraction(record.component.instanceId, interactive));
    if (result?.ok !== true) {
      report('todo-interaction', { result: 'FAIL', reason: result?.errorCode || 'runtime toggle failed' });
      return false;
    }
    trayService?.setTodoInteractionState(result.interactive === true);
    report('todo-interaction', { result: result.interactive ? 'ENABLED' : 'LOCKED', source: 'tray', instanceId: record.component.instanceId });
    return true;
  } catch {
    report('todo-interaction', { result: 'FAIL', reason: 'runtime toggle failed' });
    return false;
  }
}

async function refreshCodexQuotaFromWidget(event) {
  if (quitting) return { schemaVersion: 1, ok: false, errorCode: 'APP_EXITING', message: 'Widget 正在退出' };
  if (event?.senderFrame !== event?.sender?.mainFrame) return { schemaVersion: 1, ok: false, errorCode: 'UNAUTHORIZED_SENDER', message: 'request source is not authorized' };
  const record = widgetWindows?.findRecordBySender(event.sender);
  if (!record || record.component.type !== 'codex-quota') return { schemaVersion: 1, ok: false, errorCode: 'UNAUTHORIZED_SENDER', message: 'request source is not authorized' };
  const snapshot = await codexQuota?.refresh();
  return { schemaVersion: 1, ok: Boolean(snapshot), quota: snapshot };
}

async function dragFromWidget(event, operation, pointerId) {
  if (quitting) return { ok: false, errorCode: 'APP_EXITING' };
  if (event?.senderFrame !== event?.sender?.mainFrame) return { ok: false, errorCode: 'UNAUTHORIZED_SENDER' };
  if (!widgetWindows) return { ok: false, errorCode: 'WIDGET_RUNTIME_UNAVAILABLE' };
  return widgetWindows.dispatchDragFromCursor(event.sender, operation, pointerId);
}

function recoverWidgetWindow(instanceId, _component, reason = 'window closed') {
  if (quitting) return;
  const component = currentComponent(instanceId);
  if (!component?.visible) return;
  report('component-window', { result: 'RECOVERING', instanceId, reason: sanitizeReason(reason) });
  setTimeout(() => {
    if (quitting) return;
    const latest = currentComponent(instanceId);
    if (!latest?.visible) return;
    try {
      syncWidgetWindows(service.snapshot());
      report('component-window', { result: 'RECOVERED', instanceId });
    } catch (error) {
      report('component-window', { result: 'FAIL', instanceId, reasons: [sanitizeReason(error.message)] });
    }
  }, 0);
}

function scheduleRendererRecoveryTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_RENDERER_CRASH_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const requestedInstanceId = process.env.WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE;
  setTimeout(() => {
    if (quitting) return;
    const records = [...(widgetWindows?.windows?.values() || [])];
    const record = records.find(candidate => !requestedInstanceId || candidate.component.instanceId === requestedInstanceId);
    const instanceId = record?.component?.instanceId || requestedInstanceId || 'unknown';
    const crash = record?.window?.webContents?.forcefullyCrashRenderer;
    if (!record || typeof crash !== 'function') {
      report('renderer-recovery-test', { result: 'FAIL', instanceId, reason: 'renderer test target unavailable' });
      return;
    }
    report('renderer-recovery-test', { result: 'TRIGGERED', instanceId });
    try {
      crash.call(record.window.webContents);
    } catch (error) {
      report('renderer-recovery-test', { result: 'FAIL', instanceId, reasons: [sanitizeReason(error.message)] });
    }
  }, delayMs);
}

function scheduleNoteSmokeTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_NOTE_EDIT_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const expectedTitle = process.env.WIDGET_M1_TEST_NOTE_TITLE || 'smoke title';
  const expectedText = process.env.WIDGET_M1_TEST_NOTE_TEXT || 'smoke note';
  setTimeout(() => {
    if (quitting) return;
    const record = [...(widgetWindows?.windows?.values() || [])].find(candidate => candidate.component.type === 'note');
    if (!record || !record.window?.webContents?.executeJavaScript) {
      report('note-edit-test', { result: 'FAIL', reason: 'note test target unavailable' });
      return;
    }
    const title = JSON.stringify(expectedTitle);
    const text = JSON.stringify(expectedText);
    const script = `(() => { const title = document.querySelector('.note-title'); const body = document.querySelector('.note-body'); if (!title || !body) return false; title.value = ${title}; body.value = ${text}; title.dispatchEvent(new Event('input', { bubbles: true })); body.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
    record.window.webContents.executeJavaScript(script).then(ok => {
      report('note-edit-test', { result: ok ? 'TRIGGERED' : 'FAIL' });
      const retryDelayMs = Number(process.env.WIDGET_M1_TEST_NOTE_RETRY_MS || 0);
      if (ok && Number.isFinite(retryDelayMs) && retryDelayMs > 0) setTimeout(() => {
        record.window.webContents.executeJavaScript("(() => { const retry = document.querySelector('.note-retry'); if (!retry || retry.hidden) return false; retry.click(); return true; })()").then(retried => {
          report('note-retry-test', { result: retried ? 'TRIGGERED' : 'FAIL' });
        }).catch(error => report('note-retry-test', { result: 'FAIL', reason: sanitizeReason(error.message) }));
      }, retryDelayMs);
    }).catch(error => report('note-edit-test', { result: 'FAIL', reason: sanitizeReason(error.message) }));
  }, delayMs);
}

function scheduleTodoSmokeTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_TODO_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const expectedTitle = process.env.WIDGET_M1_TEST_TODO_TITLE || 'smoke todo';
  setTimeout(() => {
    if (quitting) return;
    const record = [...(widgetWindows?.windows?.values() || [])].find(candidate => candidate.component.type === 'daily-todo');
    if (!record || !record.window?.webContents?.executeJavaScript) {
      report('todo-edit-test', { result: 'FAIL', reason: 'daily todo test target unavailable' });
      return;
    }
    const title = JSON.stringify(expectedTitle);
    const script = `(() => { const input = document.querySelector('.todo-add input'); const button = document.querySelector('.todo-add-button'); if (!input || !button) return false; input.value = ${title}; button.click(); const checkbox = document.querySelector('.todo-item input:not(:checked)'); if (!checkbox) return false; checkbox.click(); return true; })()`;
    record.window.webContents.executeJavaScript(script).then(ok => {
      report('todo-edit-test', { result: ok ? 'TRIGGERED' : 'FAIL' });
    }).catch(error => report('todo-edit-test', { result: 'FAIL', reason: sanitizeReason(error.message) }));
  }, delayMs);
}

function scheduleManagerUiSmokeTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_MANAGER_UI_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  setTimeout(async () => {
    if (quitting || !managerWindow?.webContents?.executeJavaScript) return;
    const script = `(() => {
      const required = ['.app-mark img[src="widget-icon.svg"]', '.sidebar', '.nav-item[data-view="components"]', '.nav-item[data-view="appearance"]', '.nav-item[data-view="settings"]', '#catalog', '#components', '#catalog-total', '#catalog-pagination', '#catalog-prev', '#catalog-page', '#catalog-next', '#component-pagination', '#component-prev', '#component-page', '#component-next', '#global-theme', '#global-opacity', '#autostart-toggle', '#autostart-status'];
      const present = required.every(selector => document.querySelector(selector));
      const cards = document.querySelectorAll('#catalog .catalog-card').length;
      const instances = document.querySelectorAll('#components .instance-card').length;
      const catalogPagination = document.querySelector('#catalog-pagination');
      const catalogPage = document.querySelector('#catalog-page');
      const catalogNext = document.querySelector('#catalog-next');
      const catalogPrevious = document.querySelector('#catalog-prev');
      const componentPagination = document.querySelector('#component-pagination');
      const noScrollbars = document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.body.scrollHeight <= document.body.clientHeight;
      const compactRows = [...document.querySelectorAll('#components .instance-card')].every(row => row.querySelector('.instance-status .state') && row.querySelector('.more-actions'));
      const firstPage = cards === 3 && catalogPagination?.hidden === false && catalogPage?.textContent === '1 / 2' && catalogPrevious?.disabled === true && catalogNext?.disabled === false;
      catalogNext?.click();
      const lastPageCards = document.querySelectorAll('#catalog .catalog-card').length;
      const lastPage = lastPageCards === 2 && catalogPage?.textContent === '2 / 2' && catalogPrevious?.disabled === false && catalogNext?.disabled === true;
      const lastPageWidthsMatch = [...document.querySelectorAll('#catalog .catalog-card')].every(card => Math.abs(card.getBoundingClientRect().width - document.querySelector('#catalog .catalog-card')?.getBoundingClientRect().width) < 1);
      catalogPrevious?.click();
      const switchNode = document.querySelector('.switch');
      const switchTrack = switchNode?.querySelector('span');
      const switchStyle = switchNode ? getComputedStyle(switchNode) : null;
      const switchTrackStyle = switchTrack ? getComputedStyle(switchTrack) : null;
      const switchAligned = ['flex', 'inline-flex'].includes(switchStyle?.display) && switchStyle.width === '42px' && switchStyle.height === '24px' && switchTrackStyle?.position === 'relative' && switchTrackStyle.width === '42px' && switchTrackStyle.height === '24px';
      document.querySelector('.nav-item[data-view="appearance"]')?.click();
      const appearanceVisible = document.querySelector('#page-appearance')?.hidden === false;
      document.querySelector('.nav-item[data-view="settings"]')?.click();
      const settingsVisible = document.querySelector('#page-settings')?.hidden === false;
      document.querySelector('.nav-item[data-view="components"]')?.click();
      const componentsVisible = document.querySelector('#page-components')?.hidden === false;
      const theme = document.querySelector('#global-theme');
      if (theme) { theme.value = 'light'; theme.dispatchEvent(new Event('change', { bubbles: true })); }
      return { ok: present && firstPage && lastPage && lastPageWidthsMatch && instances === 5 && componentPagination?.hidden === true && compactRows && noScrollbars && switchAligned && appearanceVisible && settingsVisible && componentsVisible && theme?.value === 'light' };
    })()`;
    try {
      const result = await managerWindow.webContents.executeJavaScript(script);
      await managerWindow.webContents.executeJavaScript("(() => { document.querySelector('#components .card-actions .secondary')?.click(); return true; })()");
      await new Promise(resolve => setTimeout(resolve, 220));
      const editorResult = await managerWindow.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('#editor');
        const components = document.querySelector('#page-components');
        const noScrollbars = document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.body.scrollHeight <= document.body.clientHeight;
        const open = editor?.hidden === false && getComputedStyle(editor).display !== 'none' && getComputedStyle(components).display === 'none' && noScrollbars;
        document.querySelector('#editor .editor-actions .secondary')?.click();
        return { ok: open };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 220));
      managerWindow.setSize(800, 640);
      await new Promise(resolve => setTimeout(resolve, 220));
      const compactResult = await managerWindow.webContents.executeJavaScript(`(() => {
        const cards = document.querySelectorAll('#catalog .catalog-card').length;
        const instances = document.querySelectorAll('#components .instance-card').length;
        const noScrollbars = document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.body.scrollHeight <= document.body.clientHeight;
        const catalogPage = document.querySelector('#catalog-page')?.textContent;
        const componentPage = document.querySelector('#component-page')?.textContent;
        const accessible = [...document.querySelectorAll('#components .instance-card')].every(row => row.querySelector('.card-actions button') && row.querySelector('.more-actions'));
        return { ok: cards === 2 && instances === 3 && catalogPage === '1 / 3' && componentPage === '1 / 2' && noScrollbars && accessible };
      })()`);
      managerWindow.setSize(1120, 800);
      await captureManagerScreenshots();
      report('manager-ui-test', { result: result?.ok && editorResult?.ok && compactResult?.ok ? 'PASS' : 'FAIL', defaultSize: result, editor: editorResult, compactSize: compactResult });
    } catch (error) {
      managerWindow.setSize(1120, 800);
      report('manager-ui-test', { result: 'FAIL', reason: sanitizeReason(error.message) });
    }
  }, delayMs);
}

function scheduleCodexQuotaSmokeTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_CODEX_QUOTA_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  setTimeout(() => {
    if (quitting) return;
    const record = [...(widgetWindows?.windows?.values() || [])].find(candidate => candidate.component.type === 'codex-quota');
    if (!record || !record.window?.webContents?.executeJavaScript) {
      report('codex-quota-test', { result: 'FAIL', reason: 'quota test target unavailable' });
      return;
    }
    const script = `(() => {
      const root = document.querySelector('.codex-quota');
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
      const required = ['Codex 额度', '本地读取', '已同步', '周额度', '5 小时重置', '周重置', '最后更新'];
      const forbidden = ['费用', '成本', '$', '¥'];
      const primary = root?.querySelector('.quota-ring-value')?.textContent === '62%';
      const weekly = root?.querySelector('.quota-weekly-head strong')?.textContent === '剩余 78%';
      const resetValue = root?.querySelector('.quota-reset .quota-summary-value');
      const resetStyle = resetValue ? getComputedStyle(resetValue) : null;
      const resetVisible = resetStyle?.textOverflow === 'clip' && resetStyle.fontSize === '16px';
      const weeklyReset = root?.querySelector('.quota-weekly-reset .quota-summary-value')?.textContent === '2100/01/01';
      const ok = Boolean(root) && primary && weekly && resetVisible && weeklyReset && required.every(value => text.includes(value)) && forbidden.every(value => !text.includes(value));
      return { ok, primary, weekly, resetVisible, weeklyReset, text };
    })()`;
    record.window.webContents.executeJavaScript(script).then(result => {
      report('codex-quota-test', { result: result?.ok ? 'PASS' : 'FAIL', ...(result?.ok ? {} : { reason: `primary=${result?.primary}; weekly=${result?.weekly}; required text missing or forbidden text present` }) });
    }).catch(error => report('codex-quota-test', { result: 'FAIL', reason: sanitizeReason(error.message) }));
  }, delayMs);
}

function scheduleDesktopHostSmokeTest() {
  const delayMs = Number(process.env.WIDGET_M1_TEST_DESKTOP_MS || 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  setTimeout(() => {
    if (quitting) return;
    const records = [...(widgetWindows?.windows?.values() || [])];
    const ready = Boolean(hostService) && records.length > 0 && records.every(record => record.hostReady && ['ready', 'editing'].includes(record.hostPhase));
    report('desktop-host-test', { result: ready ? 'PASS' : 'FAIL', hostMode: hostService ? 'desktop' : 'floating', components: records.length, phases: records.map(record => record.hostPhase) });
  }, delayMs);
}

function persistWidgetMove(instanceId, position, context = {}) {
  const startedInEdit = context.editing === true;
  const operation = moveTail.then(async () => {
    try {
      if (startedInEdit && activeEditInstanceId !== instanceId) {
        const component = currentComponent(instanceId);
        if (!component) throw new Error('component no longer exists');
        report('component-move', { result: 'SKIPPED', instanceId, reason: 'edit session ended before move persistence' });
        return component;
      }
      const component = await service.setPosition(instanceId, position);
      try {
        if (managerWindow && typeof managerWindow.isDestroyed === 'function' && !managerWindow.isDestroyed()) {
          managerWindow.webContents.send('manager:component-moved', {
            instanceId: component.instanceId,
            x: component.bounds.x,
            y: component.bounds.y
          });
        }
      } catch {}
      report('component-move', { result: 'PASS', instanceId, x: component.bounds.x, y: component.bounds.y });
      return component;
    } catch (error) {
      report('component-move', { result: 'FAIL', instanceId, reasons: [sanitizeReason(error.message)] });
      throw error;
    }
  });
  // Keep the queue usable after a failed write while preserving the rejection
  // for the current caller so the widget can revert to its last saved position.
  moveTail = operation.catch(() => {});
  return operation;
}

function syncWidgetWindows(snapshot) {
  if (widgetWindows) widgetWindows.sync(snapshot);
}

function isAuthorizedManagerEvent(event) {
  return Boolean(managerWindow && event?.sender === managerWindow.webContents && event?.senderFrame === event.sender.mainFrame);
}

async function flushWidgetNotes() {
  const results = await widgetWindows?.requestNoteFlush?.() || [];
  const failed = results.filter(result => result?.ok !== true);
  if (failed.length === 0) return true;
  report('note-save-on-exit', { result: 'BLOCKED', count: failed.length });
  if (isAlive(managerWindow)) focusManagerWindow();
  if (isAlive(managerWindow)) {
    await dialog.showMessageBox(managerWindow, {
      type: 'error',
      buttons: ['返回便签重试'],
      title: '便签尚未保存',
      message: 'Widget 保持打开，便签内容仍在输入框中',
      detail: '请检查配置目录权限或稍后点击“重试保存”，成功后再退出。'
    });
  }
  return false;
}

function withEditPreview(snapshot, workingCopy) {
  if (!snapshot?.catalog?.components || !workingCopy?.instanceId) return snapshot;
  return {
    ...snapshot,
    catalog: {
      ...snapshot.catalog,
      components: snapshot.catalog.components.map(component => component.instanceId === workingCopy.instanceId ? workingCopy : component)
    }
  };
}

function setManagerEditMode(command, result) {
  if (!widgetWindows) return;
  if (command === 'manager:edit-begin' && result.edit?.instanceId) {
    activeEditInstanceId = result.edit.instanceId;
    activeEditSessionId = result.edit.sessionId;
    return;
  }
  if ((command === 'manager:edit-complete' || command === 'manager:edit-cancel') && activeEditInstanceId) {
    widgetWindows.setEditMode(activeEditInstanceId, false);
    activeEditInstanceId = undefined;
    activeEditSessionId = undefined;
  }
}

async function start() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  autostartService = new AutostartService({ app });
  const configPath = process.env.WIDGET_M1_CONFIG_PATH || path.join(app.getPath('userData'), 'widget-config.json');
  const store = new ConfigStore({ filePath: configPath });
  service = new AppService({ store });
  const initial = await service.start();
  createWidgetRuntime();
  syncWidgetWindows(initial);
  router = new ManagerIpcRouter({
    service,
    authorizeSender: context => Boolean(managerWindow && context?.sender === managerWindow.webContents && context?.isMainFrame === true)
  });
  ipcMain.handle('manager:dispatch', async (event, command, envelope) => {
    if (quitting) {
      const requestId = typeof envelope?.requestId === 'string' && envelope.requestId.length <= 96 ? envelope.requestId : 'unknown';
      return { schemaVersion: 1, requestId, ok: false, errorCode: 'APP_EXITING', message: 'manager is exiting' };
    }
    return operationQueue.enqueue(async () => {
      const result = await router.dispatch({ sender: event.sender, isMainFrame: event.senderFrame === event.sender.mainFrame }, command, envelope);
      if (result.ok) {
        setManagerEditMode(command, result);
        const committed = result.snapshot || service.snapshot();
        const next = command === 'manager:edit-update' ? withEditPreview(committed, result.edit?.workingCopy || result.edit) : committed;
        syncWidgetWindows(next);
        if (command === 'manager:edit-begin' && activeEditInstanceId) widgetWindows.setEditMode(activeEditInstanceId, true);
      }
      return result;
    });
  });
  ipcMain.handle('widget:note-save', (event, payload) => saveNoteFromWidget(event, payload));
  ipcMain.handle('widget:todo-update', (event, payload) => saveTodoFromWidget(event, payload));
  ipcMain.handle('widget:todo-interaction', (event, interactive) => setTodoInteractionFromWidget(event, interactive));
  ipcMain.handle('widget:drag', (event, operation, pointerId) => dragFromWidget(event, operation, pointerId));
  ipcMain.handle('widget:codex-quota-refresh', (event) => refreshCodexQuotaFromWidget(event));
  ipcMain.handle('manager:autostart', async (event, action) => {
    if (!isAuthorizedManagerEvent(event)) return { schemaVersion: 1, ok: false, errorCode: 'UNAUTHORIZED_SENDER', message: 'request source is not authorized' };
    const operation = action === 'get'
      ? () => autostartService.getState()
      : action === 'enable'
        ? () => autostartService.enable()
        : action === 'disable'
          ? () => autostartService.disable()
          : action === 'repair'
            ? () => autostartService.repair()
            : action === 'disable-and-exit'
              ? () => autostartService.disable()
              : null;
    if (!operation) return { schemaVersion: 1, ok: false, errorCode: 'INVALID_AUTOSTART_ACTION', message: '不支持的自启动操作' };
    const result = await operationQueue.enqueue(operation);
    if (action === 'disable-and-exit' && result.ok === true) setTimeout(() => { void requestExit('disable-autostart-exit'); }, 0);
    return result;
  });
  ipcMain.on('widget:note-flush-complete', (event, requestId, result) => {
    widgetWindows?.completeNoteFlush(event.sender, requestId, result);
  });
  report('manager-ready', { result: 'RECORDED', phase: initial.app.phase, configSource: initial.app.configSource });
  createTrayRuntime();
  createManagerWindow();
  scheduleTraySmokeTest();
  metrics.start();
  codexQuota.start();
  scheduleRendererRecoveryTest();
  scheduleNoteSmokeTest();
  scheduleTodoSmokeTest();
  scheduleManagerUiSmokeTest();
  scheduleCodexQuotaSmokeTest();
  scheduleDesktopHostSmokeTest();
  const autoExitMs = Number(process.env.WIDGET_M1_AUTO_EXIT_MS || 0);
  if (Number.isFinite(autoExitMs) && autoExitMs > 0) setTimeout(() => app.quit(), autoExitMs);
}

function closeReport() {
  if (reportClosed) return;
  reportClosed = true;
  report('manager-complete', { result: 'RECORDED' });
}

async function resolveActiveEdit() {
  if (!activeEditSessionId) return 'proceed';
  if (!isAlive(managerWindow)) return 'cancel';
  const result = await dialog.showMessageBox(managerWindow, {
    type: 'warning',
    buttons: ['保存并退出', '放弃更改', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '退出 Widget',
    message: '当前布局有未保存的更改',
    detail: '保存并退出会写入当前布局；放弃更改会恢复进入编辑前的布局。'
  });
  if (result.response === 0) return 'save';
  if (result.response === 1) return 'discard';
  return 'cancel';
}

async function finishActiveEdit(decision) {
  if (!activeEditSessionId || decision === 'cancel') return decision !== 'cancel';
  const sessionId = activeEditSessionId;
  try {
    const snapshot = decision === 'save'
      ? await service.completeEdit(sessionId)
      : service.cancelEdit(sessionId);
    if (activeEditInstanceId) widgetWindows.setEditMode(activeEditInstanceId, false);
    activeEditInstanceId = undefined;
    activeEditSessionId = undefined;
    syncWidgetWindows(snapshot);
    return true;
  } catch (error) {
    report('edit-exit', { result: 'SAVE_FAILED', reasons: [sanitizeReason(error.message)] });
    if (isAlive(managerWindow)) {
      await dialog.showMessageBox(managerWindow, {
        type: 'error',
        buttons: ['返回编辑'],
        title: '无法保存布局',
        message: '布局保存失败，Widget 将保持打开',
        detail: '请检查配置目录权限后重试。当前编辑内容仍保留在现场。'
      });
    }
    return false;
  }
}

async function requestExit(reason = 'unknown') {
  if (quitting) return true;
  if (closeRequestPromise) return closeRequestPromise;
  closeRequestPromise = (async () => {
    await operationQueue.wait();
    const decision = await resolveActiveEdit();
    if (decision === 'cancel') {
      report('exit-request', { result: 'CANCELLED', reason });
      return false;
    }
    if (!(await finishActiveEdit(decision))) return false;
    return (await shutdownManager(reason)) === true;
  })().finally(() => { closeRequestPromise = undefined; });
  return closeRequestPromise;
}

async function requestHideToTray() {
  if (quitting || !trayService?.isReady()) return requestExit('manager-close');
  if (closeRequestPromise) return closeRequestPromise;
  closeRequestPromise = (async () => {
    await operationQueue.wait();
    const decision = await resolveActiveEdit();
    if (decision === 'cancel') {
      report('hide-to-tray', { result: 'CANCELLED' });
      return false;
    }
    if (!(await finishActiveEdit(decision))) return false;
    return hideManagerToTray();
  })().finally(() => { closeRequestPromise = undefined; });
  return closeRequestPromise;
}

async function shutdownManager(reason = 'unknown') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (!(await flushWidgetNotes())) return false;
    quitting = true;
    operationQueue.stopAccepting();
    report('exit-request', { result: 'ACCEPTED', reason });
    metrics?.stop();
    codexQuota?.stop();
    widgetWindows?.closeAll();
    trayService?.destroy();
    try {
      await operationQueue.wait();
      await moveTail;
    } finally {
      closeReport();
      app.quit();
    }
    return true;
  })().then(result => {
    if (!result) shutdownPromise = undefined;
    return result;
  }, error => {
    shutdownPromise = undefined;
    throw error;
  });
  return shutdownPromise;
}

start().catch(error => {
  quitting = true;
  operationQueue.stopAccepting();
  metrics?.stop();
  codexQuota?.stop();
  widgetWindows?.closeAll();
  trayService?.destroy();
  report('manager-startup', { result: 'FAIL', reasons: [sanitizeReason(error.message)] });
  app.quit();
});

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  void requestExit('app-before-quit');
});

app.on('window-all-closed', () => {
  if (!quitting) void requestExit('window-all-closed');
});

module.exports = { focusManagerWindow, handleSecondInstance, requestExit, shutdownManager };
