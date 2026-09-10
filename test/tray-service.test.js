const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TrayService } = require('../src/tray-service');

class FakeTray extends EventEmitter {
  constructor(icon) {
    super();
    this.icon = icon;
    this.menu = undefined;
    this.destroyed = false;
    this.bounds = { x: 1, y: 1, width: 16, height: 16 };
  }

  setToolTip(value) { this.toolTip = value; }
  setContextMenu(menu) { this.menu = menu; }
  getBounds() { return this.bounds; }
  destroy() { this.destroyed = true; }
}

const FakeMenu = { buildFromTemplate: template => template };

function createService() {
  const actions = [];
  const service = new TrayService({
    Tray: FakeTray,
    Menu: FakeMenu,
    icon: 'icon',
    healthCheckMs: 0,
    onOpen: () => actions.push('open'),
    onToggleComponents: hidden => actions.push(hidden ? 'hide' : 'restore'),
    onToggleTodoInteraction: interactive => { actions.push(interactive ? 'todo-unlock' : 'todo-lock'); return true; },
    onEditLayout: () => actions.push('edit'),
    onSettings: () => actions.push('settings'),
    onExit: () => actions.push('exit')
  });
  return { service, actions };
}

test('creates an operable tray menu and updates temporary visibility state', () => {
  const { service, actions } = createService();
  assert.equal(service.start(), true);
  assert.equal(service.isReady(), true);
  assert.deepEqual(service.tray.menu.filter(item => item.label).map(item => item.label), ['打开管理器', '暂时隐藏全部组件', '锁定每日待办', '编辑布局', '设置', '退出 Widget']);
  service.tray.emit('click');
  service.tray.menu.find(item => item.label === '暂时隐藏全部组件').click();
  service.setComponentsHidden(true);
  assert.deepEqual(actions, ['open', 'hide']);
  assert.equal(service.tray.menu.find(item => item.label === '恢复显示组件').label, '恢复显示组件');
  service.tray.menu.find(item => item.label === '锁定每日待办').click();
  assert.deepEqual(actions, ['open', 'hide', 'todo-lock']);
  assert.equal(service.tray.menu.find(item => item.label === '解锁每日待办').label, '解锁每日待办');
  service.tray.menu.find(item => item.label === '退出 Widget').click();
  assert.deepEqual(actions, ['open', 'hide', 'todo-lock', 'exit']);
  service.destroy();
  assert.equal(service.isReady(), false);
});

test('recreates the tray when its shell bounds become unavailable', () => {
  const { service } = createService();
  service.start();
  const first = service.tray;
  first.bounds = undefined;
  service.checkHealth();
  assert.notEqual(service.tray, first);
  assert.equal(first.destroyed, true);
  service.destroy();
});
