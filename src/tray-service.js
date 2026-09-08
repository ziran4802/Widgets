class TrayService {
  constructor({ Tray, Menu, icon, toolTip = 'Widget', onOpen, onToggleComponents, onEditLayout, onSettings, onExit, onError = () => {}, healthCheckMs = 5000 } = {}) {
    if (typeof Tray !== 'function') throw new TypeError('Tray constructor is required');
    if (!Menu || typeof Menu.buildFromTemplate !== 'function') throw new TypeError('Menu.buildFromTemplate is required');
    if (typeof onOpen !== 'function' || typeof onToggleComponents !== 'function' || typeof onEditLayout !== 'function' || typeof onSettings !== 'function' || typeof onExit !== 'function') throw new TypeError('tray callbacks are required');
    this.Tray = Tray;
    this.Menu = Menu;
    this.icon = icon;
    this.toolTip = toolTip;
    this.callbacks = { onOpen, onToggleComponents, onEditLayout, onSettings, onExit };
    this.onError = onError;
    this.healthCheckMs = healthCheckMs;
    this.tray = undefined;
    this.menu = undefined;
    this.healthTimer = undefined;
    this.componentsHidden = false;
  }

  isReady() {
    return Boolean(this.tray);
  }

  menuTemplate() {
    return [
      { label: '打开管理器', click: () => this.callbacks.onOpen() },
      { type: 'separator' },
      { label: this.componentsHidden ? '恢复显示组件' : '暂时隐藏全部组件', click: () => this.callbacks.onToggleComponents(!this.componentsHidden) },
      { label: '编辑布局', click: () => this.callbacks.onEditLayout() },
      { label: '设置', click: () => this.callbacks.onSettings() },
      { type: 'separator' },
      { label: '退出 Widget', click: () => this.callbacks.onExit() }
    ];
  }

  rebuildMenu() {
    if (!this.tray) return;
    this.menu = this.Menu.buildFromTemplate(this.menuTemplate());
    this.tray.setContextMenu(this.menu);
  }

  createTray() {
    const tray = new this.Tray(this.icon);
    tray.setToolTip(this.toolTip);
    tray.on('click', () => this.callbacks.onOpen());
    this.tray = tray;
    this.rebuildMenu();
    return tray;
  }

  start() {
    if (this.tray) return true;
    try {
      this.createTray();
      if (Number.isFinite(this.healthCheckMs) && this.healthCheckMs > 0) this.healthTimer = setInterval(() => this.checkHealth(), this.healthCheckMs);
      return true;
    } catch (error) {
      this.tray = undefined;
      this.menu = undefined;
      try { this.onError(error); } catch {}
      return false;
    }
  }

  setComponentsHidden(hidden) {
    this.componentsHidden = Boolean(hidden);
    this.rebuildMenu();
  }

  checkHealth() {
    if (!this.tray || typeof this.tray.getBounds !== 'function') return;
    try {
      const bounds = this.tray.getBounds();
      if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) return;
      this.recreate();
    } catch (error) {
      try { this.onError(error); } catch {}
      this.recreate();
    }
  }

  recreate() {
    if (!this.tray) return false;
    try { this.tray.destroy(); } catch {}
    this.tray = undefined;
    try {
      this.createTray();
      return true;
    } catch (error) {
      try { this.onError(error); } catch {}
      this.tray = undefined;
      return false;
    }
  }

  destroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    if (this.tray) {
      try { this.tray.destroy(); } catch {}
    }
    this.tray = undefined;
    this.menu = undefined;
  }
}

module.exports = { TrayService };
