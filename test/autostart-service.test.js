const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTOSTART_ARGUMENTS,
  AutostartService,
  classifyAutostartState,
  isPortableProductPath,
  normalizeLoginItemSettings,
  sameArgs,
  samePath
} = require('../src/autostart-service');

test('recognizes the formal portable executable and compares Windows paths safely', () => {
  assert.equal(isPortableProductPath('C:\\Widget\\Widget.exe'), true);
  assert.equal(isPortableProductPath('C:\\Widget\\electron.exe'), false);
  assert.equal(samePath('C:\\Widget\\Widget.exe', 'c:/widget/Widget.exe'), true);
  assert.equal(sameArgs(['--autostart', '--silent-autostart'], AUTOSTART_ARGUMENTS), true);
});

test('normalizes Electron login item settings including launch item fallbacks', () => {
  assert.deepEqual(normalizeLoginItemSettings({
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
    launchItems: [{ path: 'C:\\Old\\Widget.exe', args: ['--autostart'] }]
  }), {
    openAtLogin: true,
    effective: false,
    path: 'C:\\Old\\Widget.exe',
    args: ['--autostart']
  });
});

test('classifies disabled, enabled, path mismatch and Windows-disabled states', () => {
  const expectedPath = 'C:\\New\\Widget.exe';
  const expectedArgs = AUTOSTART_ARGUMENTS;
  assert.equal(classifyAutostartState({ expectedPath, expectedArgs, settings: {} }).status, 'disabled');
  assert.equal(classifyAutostartState({ expectedPath, expectedArgs, settings: { openAtLogin: true, executableWillLaunchAtLogin: true, path: expectedPath, args: expectedArgs } }).status, 'enabled');
  assert.equal(classifyAutostartState({ expectedPath, expectedArgs, settings: { openAtLogin: true, executableWillLaunchAtLogin: true, path: 'C:\\Old\\Widget.exe', args: expectedArgs } }).status, 'path-mismatch');
  assert.equal(classifyAutostartState({ expectedPath, expectedArgs, settings: { openAtLogin: true, executableWillLaunchAtLogin: false, path: expectedPath, args: expectedArgs } }).status, 'system-disabled');
});

test('refuses to touch real login settings in development and unsupported environments', async () => {
  let writes = 0;
  const service = new AutostartService({
    platform: 'win32',
    isPackaged: false,
    executablePath: 'C:\\Dev\\electron.exe',
    setSettings: () => { writes += 1; }
  });
  assert.equal((await service.getState()).status, 'unsupported');
  assert.equal((await service.enable()).errorCode, 'AUTOSTART_UNSUPPORTED');
  assert.equal(writes, 0);
  assert.equal((await new AutostartService({ platform: 'linux', isPackaged: true, executablePath: '/opt/Widget.exe' }).getState()).status, 'unsupported');
});

test('enables, reads and repairs a packaged portable path through injected APIs', async () => {
  let actual = { openAtLogin: false };
  const calls = [];
  const service = new AutostartService({
    platform: 'win32',
    isPackaged: true,
    executablePath: 'C:\\New\\Widget.exe',
    getSettings: () => actual,
    setSettings: settings => {
      calls.push(settings);
      actual = { ...settings, executableWillLaunchAtLogin: true };
    }
  });
  assert.equal((await service.getState()).status, 'disabled');
  assert.equal((await service.enable()).status, 'enabled');
  assert.deepEqual(calls[0], {
    openAtLogin: true,
    enabled: true,
    path: 'C:\\New\\Widget.exe',
    args: [...AUTOSTART_ARGUMENTS],
    name: 'Widget'
  });
  actual = { openAtLogin: true, executableWillLaunchAtLogin: true, path: 'C:\\Old\\Widget.exe', args: [...AUTOSTART_ARGUMENTS] };
  assert.equal((await service.getState()).status, 'path-mismatch');
  assert.equal((await service.repair()).status, 'enabled');
  assert.equal((await service.disable()).requested, false);
  assert.equal(calls.at(-1).openAtLogin, false);
});

test('keeps expected and effective state separate when Windows blocks the login item', async () => {
  const service = new AutostartService({
    platform: 'win32',
    isPackaged: true,
    executablePath: 'C:\\Widget\\Widget.exe',
    getSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: false, path: 'C:\\Widget\\Widget.exe', args: [...AUTOSTART_ARGUMENTS] }),
    setSettings: () => {}
  });
  const result = await service.getState();
  assert.equal(result.status, 'system-disabled');
  assert.equal(result.expected.path, 'C:\\Widget\\Widget.exe');
  assert.equal(result.effective.enabled, false);
  assert.equal(result.effective.openAtLogin, true);
});
