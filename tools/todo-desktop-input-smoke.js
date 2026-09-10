// Run with Electron in a visible desktop session. Uses an isolated profile and
// in-memory todo data. Moves/restores the cursor; minimizing an obstruction is
// opt-in and its original placement is restored during cleanup.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const koffi = require('koffi');
const { WidgetWindowService } = require('../src/widget-window-service');
const { WorkerWHostAdapter } = require('../src/workerw-host-adapter');
const { HostService } = require('../src/host-service');
const { createDefaultComponent } = require('../src/config-contract');
const { loadNativeHostAdapter } = require('../src/native-host');

const native = loadNativeHostAdapter();
const user32 = koffi.load('user32.dll');
const getFocus = user32.func('uintptr_t GetFocus()');
const getCursor = user32.func('bool GetCursorPos(_Out_ void *)');
const setCursor = user32.func('bool SetCursorPos(int, int)');
const mouse = user32.func('void mouse_event(uint, uint, uint, uint, uintptr_t)');
const metric = user32.func('int GetSystemMetrics(int)');
const sendInput = user32.func('uint SendInput(uint, _In_ void *, int)');
const show = user32.func('bool ShowWindow(uintptr_t, int)');
const getPlacement = user32.func('bool GetWindowPlacement(uintptr_t, _Out_ void *)');
const setPlacement = user32.func('bool SetWindowPlacement(uintptr_t, void *)');
const enabled = user32.func('bool IsWindowEnabled(uintptr_t)');
const placements = new Map();
const originalCursor = Buffer.alloc(8);
const cursorSaved = getCursor(originalCursor);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-input-smoke-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let windows;
let record;
let items = [];
let finishing = false;
const result = {};
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

ipcMain.handle('widget:todo-update', (_event, state) => {
  items = state.items;
  return { ok: true };
});
ipcMain.handle('widget:todo-interaction', (_event, value) => windows.setTodoInteraction('input-fixture', value));

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  const records = [...(windows?.windows.values() || [])];
  windows?.closeAll();
  await Promise.all(records.map(entry => entry.hostTask));
  if (cursorSaved) setCursor(originalCursor.readInt32LE(0), originalCursor.readInt32LE(4));
  for (const [handle, placement] of placements) setPlacement(handle, placement);
  console.log(JSON.stringify({ ok: !error, ...result, ...(error ? { error: error.message } : {}) }));
  // Electron can still hold the profile open; never remove user profiles.
  app.once('quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
  await pause(200);
  if (error) app.exit(1);
  else app.quit();
}
const timeout = setTimeout(() => void finish(new Error('desktop input test timed out')), 15000);

app.whenReady().then(async () => {
  try {
    const display = screen.getPrimaryDisplay();
    const adapter = new WorkerWHostAdapter({ nativeHost: native, createWindow: () => {}, getDisplay: () => display });
    const host = new HostService({ adapter });
    windows = new WidgetWindowService({
      createWindow: options => new BrowserWindow(options),
      preloadPath: path.join(__dirname, '../src/widget-preload.js'),
      pagePath: path.join(__dirname, '../src/widget.html'),
      hostService: host
    });
    const todo = createDefaultComponent('daily-todo', 'input-fixture');
    todo.bounds = { x: Math.max(0, display.workArea.width - 380), y: display.workArea.height - 430, width: 360, height: 420, unit: 'dip' };
    windows.sync({ catalog: { components: [todo] } });
    record = windows.windows.get(todo.instanceId);
    await record.hostTask;
    if (!record.hostReady) throw new Error('WorkerW attachment unavailable');
    await pause(800);
    const hwnd = record.window.getNativeWindowHandle().readBigUInt64LE();
    const state = host.getRecord(todo.instanceId).hostState.nativeState;
    await record.window.webContents.executeJavaScript(`(() => {
      window.inputSmokeClicks = [];
      document.addEventListener('click', event => window.inputSmokeClicks.push({
        tag: event.target.tagName, type: event.target.type, x: event.clientX, y: event.clientY
      }));
    })()`);

    async function click(selector, retry = false) {
      const local = await record.window.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      const rect = native.observe(record.window, state, todo.bounds, display.scaleFactor, 'editing').actualClient;
      const point = { x: Math.round(rect.left + local.x * display.scaleFactor), y: Math.round(rect.top + local.y * display.scaleFactor) };
      const hit = native.samplePoint(record.window, point);
      if (!['SHELLDLL_DefView', 'SysListView32', 'Progman', 'WorkerW'].includes(hit.hitClass)
          && hit.hitParent !== hwnd && hit.hitWindow !== hwnd) {
        if (process.argv.includes('--minimize-obstruction') && !retry
            && hit.hitAncestor !== state.worker && hit.hitAncestor !== state.progman) {
          const saved = Buffer.alloc(44);
          saved.writeUInt32LE(44);
          if (getPlacement(hit.hitAncestor, saved)) {
            placements.set(hit.hitAncestor, saved);
            show(hit.hitAncestor, 6);
            await pause(300);
            return click(selector, true);
          }
        }
        throw new Error(`test point covered by ${hit.hitClass}; expose the desktop first`);
      }
      // Send motion through the low-level hook. SetCursorPos would teleport
      // past a hook that incorrectly suppresses WM_MOUSEMOVE.
      mouse(0x8001, Math.ceil(point.x * 65536 / metric(0)), Math.ceil(point.y * 65536 / metric(1)), 0, 0);
      await pause(100);
      const actual = Buffer.alloc(8);
      if (!getCursor(actual) || Math.abs(actual.readInt32LE(0) - point.x) > 1
          || Math.abs(actual.readInt32LE(4) - point.y) > 1) {
        throw new Error('system cursor could not move into the widget');
      }
      result.cursorMoved = true;
      mouse(2, 0, 0, 0, 0);
      mouse(4, 0, 0, 0, 0);
      await pause(250);
    }

    await click('.todo-add input');
    result.focus = BigInt(getFocus()) === hwnd;
    if (!result.focus) throw new Error('native keyboard focus not obtained');
    const input = Buffer.alloc(80); // Two Windows x64 INPUT records, Unicode a down/up.
    for (let index = 0; index < 2; index++) {
      input.writeUInt32LE(1, index * 40);
      input.writeUInt16LE(97, index * 40 + 10);
      input.writeUInt32LE(index ? 6 : 4, index * 40 + 12);
    }
    result.keys = sendInput(2, input, 40);
    await pause(250);
    result.text = await record.window.webContents.executeJavaScript("document.querySelector('.todo-add input').value");
    await click('.todo-add-button');
    result.added = items.length === 1 && items[0].title === 'a';
    await click('.todo-item input');
    result.completed = items.length === 1 && items[0].completed;
    await windows.setTodoInteraction(todo.instanceId, false);
    result.locked = record.todoInteractive === false;
    const parentBeforeUnlock = enabled(state.worker);
    await windows.setTodoInteraction(todo.instanceId, true);
    result.unlocked = record.todoInteractive === true && enabled(state.worker);
    await windows.setTodoInteraction(todo.instanceId, false);
    result.parentRestored = enabled(state.worker) === parentBeforeUnlock;
    if (!result.cursorMoved || !result.focus || result.keys !== 2 || result.text !== 'a' || !result.added
        || !result.completed || !result.locked || !result.unlocked || !result.parentRestored) {
      result.clicks = await record.window.webContents.executeJavaScript('window.inputSmokeClicks');
      throw new Error('desktop input verification failed');
    }
    await finish();
  } catch (error) { await finish(error); }
});
