const MOVE = 0x0200;
const DOWN = 0x0201;
const UP = 0x0202;
const WHEEL = 0x020a;
let callbackType;

// Only an active desktop-interactive widget can receive forwarded input. A
// click which started in another application must never finish inside it.
function createInputRoute({ getTargets, inspect, deliver }) {
  let pressed;
  return (message, point, mouseData = 0) => {
    if (![MOVE, DOWN, UP, WHEEL].includes(message)) return false;
    const targets = getTargets();
    if (pressed && !targets.some(target => target.window === pressed.window)) pressed = undefined;
    const target = pressed || targets.find(candidate => inspect(candidate, point)?.desktopHit);
    if (!target || (message === UP && !pressed)) return false;
    const hit = inspect(target, point);
    if (!hit || (!pressed && !hit.desktopHit)) return false;
    if (message === DOWN) pressed = target;
    deliver(target, { message, point, x: hit.x, y: hit.y, mouseData, pressed: Boolean(pressed) });
    if (message === UP) pressed = undefined;
    // The system must still receive motion to update the actual cursor. Only
    // button/wheel events routed away from the desktop should be consumed.
    return message !== MOVE;
  };
}

function startDesktopInputRouter({ koffi, getTargets }) {
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct({ x: 'int32_t', y: 'int32_t' });
  const MOUSE = koffi.struct({ pt: POINT, mouseData: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', extra: 'uintptr_t' });
  callbackType ||= koffi.proto('intptr_t __stdcall DesktopMouseCallback(int code, uintptr_t message, void * data)');
  const install = user32.func('SetWindowsHookExW', 'uintptr_t', ['int', koffi.pointer(callbackType), 'uintptr_t', 'uint']);
  const unhook = user32.func('bool UnhookWindowsHookEx(uintptr_t hook)');
  const next = user32.func('intptr_t CallNextHookEx(uintptr_t hook, int code, uintptr_t message, void * data)');
  const hitTest = user32.func('WindowFromPoint', 'uintptr_t', [POINT]);
  const getRoot = user32.func('uintptr_t GetAncestor(uintptr_t window, uint flags)');
  const getClass = user32.func('int GetClassNameW(uintptr_t window, _Out_ void * buffer, int count)');
  const getClient = user32.func('bool GetClientRect(uintptr_t window, _Out_ void * rect)');
  const toScreen = user32.func('bool ClientToScreen(uintptr_t window, _Inout_ void * point)');
  const visible = user32.func('bool IsWindowVisible(uintptr_t window)');
  const foreground = user32.func('bool SetForegroundWindow(uintptr_t window)');
  const focus = user32.func('uintptr_t SetFocus(uintptr_t window)');
  const post = user32.func('bool PostMessageW(uintptr_t window, uint message, uintptr_t wParam, intptr_t lParam)');
  const keyState = user32.func('short GetKeyState(int key)');
  const doubleClickTime = user32.func('uint GetDoubleClickTime()');
  let stopped = false;
  let lastDown;
  const hwnd = target => target.window.getNativeWindowHandle().readBigUInt64LE();
  const inspect = (target, point) => {
    const child = hwnd(target);
    if (!visible(child)) return undefined;
    const rect = Buffer.alloc(16);
    const origin = Buffer.alloc(8);
    if (!getClient(child, rect) || !toScreen(child, origin)) return undefined;
    const x = point.x - origin.readInt32LE(0);
    const y = point.y - origin.readInt32LE(4);
    const inside = x >= 0 && y >= 0 && x < rect.readInt32LE(8) && y < rect.readInt32LE(12);
    let desktopHit = false;
    if (inside) {
      const hit = hitTest(point);
      const buffer = Buffer.alloc(256);
      const length = getClass(hit, buffer, 128);
      const name = buffer.toString('utf16le', 0, length * 2);
      // A normal app covering the todo wins. Never duplicate native clicks
      // which already hit the widget or its Chromium child.
      desktopHit = ['Progman', 'WorkerW', 'SHELLDLL_DefView', 'SysListView32'].includes(name)
        && BigInt(getRoot(hit, 2)) === BigInt(getRoot(target.worker, 2));
    }
    return { x, y, desktopHit };
  };
  const route = createInputRoute({ getTargets, inspect, deliver: (target, event) => {
    // Leave the low-level hook quickly; Electron/Win32 focus dispatch can
    // synchronously send messages to other threads.
    setImmediate(() => {
      if (stopped || !getTargets().some(candidate => candidate.window === target.window)) return;
      try {
        const child = hwnd(target);
        let message = event.message;
        if (message === DOWN) {
          foreground(getRoot(child, 2));
          focus(child);
          target.window.webContents.focus();
          const now = Date.now();
          if (lastDown?.window === target.window && now - lastDown.at <= doubleClickTime()
              && Math.abs(lastDown.x - event.x) <= 4 && Math.abs(lastDown.y - event.y) <= 4) {
            message = 0x0203;
            lastDown = undefined;
          } else lastDown = { window: target.window, x: event.x, y: event.y, at: now };
        }
        let buttons = event.pressed && message !== UP ? 1 : 0;
        if (keyState(0x10) < 0) buttons |= 4;
        if (keyState(0x11) < 0) buttons |= 8;
        const x = message === WHEEL ? event.point.x : event.x;
        const y = message === WHEEL ? event.point.y : event.y;
        const wParam = message === WHEEL ? ((event.mouseData & 0xffff0000) | buttons) >>> 0 : buttons;
        post(child, message, wParam, (y << 16) | (x & 0xffff));
      } catch { /* A destroyed window must not break the desktop input hook. */ }
    });
  } });
  const callback = koffi.register((code, message, data) => {
    try {
      if (!stopped && code >= 0 && [MOVE, DOWN, UP, WHEEL].includes(Number(message))) {
        const mouse = koffi.decode(data, MOUSE);
        if (route(Number(message), mouse.pt, mouse.mouseData)) return 1;
      }
    } catch { /* Fail open: preserve ordinary desktop input. */ }
    return next(0, code, message, data);
  }, koffi.pointer(callbackType));
  const hook = install(14, callback, 0, 0);
  if (!hook) {
    koffi.unregister(callback);
    throw new Error('desktop mouse routing hook unavailable');
  }
  return { stop() {
    if (stopped) return;
    stopped = true;
    // Keep the callback alive if Windows could not detach the hook.
    if (unhook(hook)) koffi.unregister(callback);
  } };
}

module.exports = { createInputRoute, startDesktopInputRouter };


