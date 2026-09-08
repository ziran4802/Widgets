const path = require('node:path');

const AUTOSTART_ARGUMENTS = Object.freeze(['--autostart', '--silent-autostart']);
const AUTOSTART_SCHEMA_VERSION = 1;

function cloneArgs(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 16) : [];
}

function normalizePath(value) {
  return typeof value === 'string' && value.trim() ? path.normalize(value) : undefined;
}

function samePath(left, right) {
  return Boolean(left && right && path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase());
}

function sameArgs(left, right) {
  const a = cloneArgs(left);
  const b = cloneArgs(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isPortableProductPath(executablePath) {
  return typeof executablePath === 'string' && path.basename(executablePath).toLowerCase() === 'widget.exe';
}

function normalizeLoginItemSettings(value = {}) {
  const launchItems = Array.isArray(value.launchItems) ? value.launchItems.filter(item => item && typeof item === 'object') : [];
  const launchItem = launchItems[0] || {};
  const openAtLogin = value.openAtLogin === true || value.enabled === true;
  const effective = typeof value.executableWillLaunchAtLogin === 'boolean'
    ? value.executableWillLaunchAtLogin
    : openAtLogin;
  return {
    openAtLogin,
    effective,
    path: normalizePath(value.path || value.executablePath || launchItem.path || launchItem.executablePath),
    args: cloneArgs(value.args || launchItem.args)
  };
}

function unsupportedState(reason, expectedPath) {
  return {
    schemaVersion: AUTOSTART_SCHEMA_VERSION,
    ok: true,
    supported: false,
    status: 'unsupported',
    message: reason,
    expected: { path: expectedPath, args: [...AUTOSTART_ARGUMENTS] },
    effective: { enabled: false, path: undefined, args: [] }
  };
}

function classifyAutostartState({ expectedPath, expectedArgs = AUTOSTART_ARGUMENTS, settings, error } = {}) {
  const expected = { path: normalizePath(expectedPath), args: cloneArgs(expectedArgs) };
  if (error) {
    return {
      schemaVersion: AUTOSTART_SCHEMA_VERSION,
      ok: true,
      supported: true,
      status: 'unavailable',
      message: '无法读取 Windows 当前用户启动状态',
      expected,
      effective: { enabled: false, path: undefined, args: [] },
      errorCode: 'AUTOSTART_STATE_UNAVAILABLE'
    };
  }
  const actual = normalizeLoginItemSettings(settings);
  let status = 'disabled';
  if (actual.openAtLogin && !actual.effective) status = 'system-disabled';
  else if (actual.effective && actual.path && !samePath(actual.path, expected.path)) status = 'path-mismatch';
  else if (actual.openAtLogin || actual.effective) status = 'enabled';
  return {
    schemaVersion: AUTOSTART_SCHEMA_VERSION,
    ok: true,
    supported: true,
    status,
    message: status === 'path-mismatch'
      ? '启动项仍指向旧版 Widget.exe 路径'
      : status === 'system-disabled'
        ? '启动项已登记，但 Windows 当前未允许它生效'
        : status === 'enabled'
          ? '已登记当前 portable Widget.exe'
          : '未启用开机自启动',
    expected,
    effective: {
      enabled: actual.effective,
      openAtLogin: actual.openAtLogin,
      path: actual.path,
      args: actual.args
    }
  };
}

class AutostartService {
  constructor({
    app,
    platform = process.platform,
    isPackaged = app?.isPackaged === true,
    executablePath = app?.getPath?.('exe'),
    getSettings = app?.getLoginItemSettings?.bind(app),
    setSettings = app?.setLoginItemSettings?.bind(app)
  } = {}) {
    this.platform = platform;
    this.isPackaged = isPackaged === true;
    this.executablePath = normalizePath(executablePath);
    this.getSettings = getSettings;
    this.setSettings = setSettings;
  }

  get supported() {
    return this.platform === 'win32' && this.isPackaged && isPortableProductPath(this.executablePath);
  }

  expected() {
    return { path: this.executablePath, args: [...AUTOSTART_ARGUMENTS] };
  }

  async getState() {
    if (!this.supported) return unsupportedState('仅 portable Widget.exe 支持 Windows 当前用户自启动', this.executablePath);
    if (typeof this.getSettings !== 'function') {
      const expected = this.expected();
      return classifyAutostartState({ expectedPath: expected.path, expectedArgs: expected.args, error: new Error('getLoginItemSettings unavailable') });
    }
    try {
      const settings = await this.getSettings({ path: this.executablePath, args: [...AUTOSTART_ARGUMENTS] });
      const expected = this.expected();
      return classifyAutostartState({ expectedPath: expected.path, expectedArgs: expected.args, settings });
    } catch (error) {
      const expected = this.expected();
      return classifyAutostartState({ expectedPath: expected.path, expectedArgs: expected.args, error });
    }
  }

  async setEnabled(enabled) {
    if (!this.supported) {
      return { ...unsupportedState('仅 portable Widget.exe 支持 Windows 当前用户自启动', this.executablePath), ok: false, errorCode: 'AUTOSTART_UNSUPPORTED' };
    }
    if (typeof this.setSettings !== 'function') {
      return { ...(await this.getState()), ok: false, errorCode: 'AUTOSTART_API_UNAVAILABLE', message: '当前 Electron 无法修改 Windows 当前用户启动状态' };
    }
    try {
      await this.setSettings({
        openAtLogin: enabled,
        enabled,
        path: this.executablePath,
        args: [...AUTOSTART_ARGUMENTS],
        name: 'Widget'
      });
      const state = await this.getState();
      return { ...state, ok: true, requested: enabled };
    } catch (error) {
      const state = await this.getState();
      return { ...state, ok: false, errorCode: 'AUTOSTART_WRITE_FAILED', message: '无法修改 Windows 当前用户启动状态，请稍后重试' };
    }
  }

  enable() { return this.setEnabled(true); }
  disable() { return this.setEnabled(false); }
  repair() { return this.enable(); }
}

module.exports = {
  AUTOSTART_ARGUMENTS,
  AUTOSTART_SCHEMA_VERSION,
  AutostartService,
  classifyAutostartState,
  isPortableProductPath,
  normalizeLoginItemSettings,
  sameArgs,
  samePath
};
