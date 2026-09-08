const {
  COMPONENT_TYPES,
  createDefaultComponent,
  createDefaultConfig,
  normalizeComponent,
  normalizeBounds,
  normalizeNoteConfig,
  normalizeSettings,
  normalizeConfig,
  clone
} = require('./config-contract');

const CATALOG_DEFINITIONS = Object.freeze([
  Object.freeze({ type: 'system-monitor', displayName: '系统监测' }),
  Object.freeze({ type: 'clock-date', displayName: '时钟 / 日期' }),
  Object.freeze({ type: 'note', displayName: '便签' }),
  Object.freeze({ type: 'codex-quota', displayName: 'Codex 额度' })
]);

class CatalogStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogStateError';
    this.code = code;
  }
}

function findComponent(config, instanceId) {
  return config.components.find(component => component.instanceId === instanceId);
}

class CatalogState {
  constructor(config = createDefaultConfig()) {
    this.config = normalizeConfig(config);
    this.revision = 0;
    this.activeEdit = null;
    this.nextIds = Object.fromEntries(COMPONENT_TYPES.map(type => [type, this.initialNextId(type)]));
  }

  initialNextId(type) {
    const prefix = `${type}-`;
    let max = 0;
    for (const component of this.config.components) {
      if (!component.instanceId.startsWith(prefix)) continue;
      const suffix = Number(component.instanceId.slice(prefix.length));
      if (Number.isInteger(suffix) && suffix > max) max = suffix;
    }
    return max + 1;
  }

  getConfig() {
    return clone(this.config);
  }

  cloneForTransaction() {
    const copy = new CatalogState(this.config);
    copy.revision = this.revision;
    copy.activeEdit = this.activeEdit ? clone(this.activeEdit) : null;
    copy.nextIds = { ...this.nextIds };
    return copy;
  }

  getSnapshot() {
    const components = this.config.components.map(component => ({
      instanceId: component.instanceId,
      type: component.type,
      displayName: component.displayName,
      visible: component.visible,
      locked: component.locked,
      displayId: component.displayId,
      bounds: clone(component.bounds),
      theme: clone(component.theme),
      config: clone(component.config),
      lifecycle: component.visible ? 'ready' : 'hidden'
    }));
    const items = CATALOG_DEFINITIONS.map(definition => {
      const component = this.config.components.find(item => item.type === definition.type);
      return {
        type: definition.type,
        displayName: definition.displayName,
        available: !component,
        instanceId: component?.instanceId,
        visible: component?.visible,
        lifecycle: component ? (component.visible ? 'ready' : 'hidden') : 'available'
      };
    });
    return {
      revision: this.revision,
      settings: clone(this.config.settings),
      components,
      catalog: items,
      activeEdit: this.activeEdit ? { sessionId: this.activeEdit.sessionId, instanceId: this.activeEdit.instanceId, windowGeneration: this.activeEdit.windowGeneration } : null
    };
  }

  ensureNoEdit() {
    if (this.activeEdit) throw new CatalogStateError('EDIT_IN_PROGRESS', 'an edit transaction is already active');
  }

  commit(nextConfig) {
    this.config = normalizeConfig(nextConfig);
    this.revision += 1;
    return this.getConfig();
  }

  addComponent(type) {
    this.ensureNoEdit();
    if (!COMPONENT_TYPES.includes(type)) throw new CatalogStateError('UNKNOWN_COMPONENT_TYPE', 'component type is not supported');
    if (this.config.components.some(component => component.type === type)) throw new CatalogStateError('COMPONENT_ALREADY_EXISTS', 'only one instance of this component type is supported in v1');
    const instanceId = `${type}-${this.nextIds[type]}`;
    this.nextIds[type] += 1;
    const component = createDefaultComponent(type, instanceId);
    const next = { ...this.config, components: [...this.config.components, component] };
    this.commit(next);
    return clone(component);
  }

  removeComponent(instanceId) {
    this.ensureNoEdit();
    if (!findComponent(this.config, instanceId)) throw new CatalogStateError('COMPONENT_NOT_FOUND', 'component instance does not exist');
    this.commit({ ...this.config, components: this.config.components.filter(component => component.instanceId !== instanceId) });
    return this.getSnapshot();
  }

  setVisible(instanceId, visible) {
    this.ensureNoEdit();
    if (typeof visible !== 'boolean') throw new CatalogStateError('INVALID_VALUE', 'visible must be boolean');
    const component = findComponent(this.config, instanceId);
    if (!component) throw new CatalogStateError('COMPONENT_NOT_FOUND', 'component instance does not exist');
    const nextComponent = { ...component, visible };
    this.commit({ ...this.config, components: this.config.components.map(item => item.instanceId === instanceId ? nextComponent : item) });
    return clone(nextComponent);
  }

  setSettings(patch) {
    this.ensureNoEdit();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CatalogStateError('INVALID_VALUE', 'settings patch must be an object');
    const allowed = new Set(['theme', 'globalLocked', 'opacity']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new CatalogStateError('INVALID_VALUE', `setting ${key} cannot be edited`);
    const settings = normalizeSettings({ ...this.config.settings, ...clone(patch) });
    this.commit({ ...this.config, settings });
    return clone(settings);
  }

  setNoteContent(instanceId, content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new CatalogStateError('INVALID_VALUE', 'note content must be an object');
    const component = findComponent(this.config, instanceId);
    if (!component) throw new CatalogStateError('COMPONENT_NOT_FOUND', 'component instance does not exist');
    if (component.type !== 'note') throw new CatalogStateError('INVALID_COMPONENT_TYPE', 'only note components have editable content');
    const nextConfig = normalizeNoteConfig({
      ...component.config,
      title: content.title === undefined ? component.config.title : content.title,
      text: content.text === undefined ? component.config.text : content.text
    }, 'note.config');
    const nextComponent = normalizeComponent({ ...component, config: nextConfig });
    this.commit({ ...this.config, components: this.config.components.map(item => item.instanceId === instanceId ? nextComponent : item) });
    if (this.activeEdit?.instanceId === instanceId) {
      this.activeEdit = {
        ...this.activeEdit,
        workingCopy: normalizeComponent({ ...this.activeEdit.workingCopy, config: { ...this.activeEdit.workingCopy.config, title: nextConfig.title, text: nextConfig.text } })
      };
    }
    return clone(nextComponent);
  }

  setPosition(instanceId, position) {
    if (!position || typeof position !== 'object' || Array.isArray(position) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new CatalogStateError('INVALID_VALUE', 'position must contain finite x and y');
    }
    const component = findComponent(this.config, instanceId);
    if (!component) throw new CatalogStateError('COMPONENT_NOT_FOUND', 'component instance does not exist');
    const nextComponent = { ...component, bounds: normalizeBounds({ ...component.bounds, x: position.x, y: position.y }) };
    if (this.activeEdit?.instanceId === instanceId) {
      // A drag inside an edit session is part of the working copy. It must
      // not reach disk until Complete; Cancel therefore restores the saved
      // position just like it restores unsaved size and theme changes.
      this.activeEdit = {
        ...this.activeEdit,
        workingCopy: {
          ...this.activeEdit.workingCopy,
          bounds: normalizeBounds({
            ...this.activeEdit.workingCopy.bounds,
            x: nextComponent.bounds.x,
            y: nextComponent.bounds.y,
            unit: 'dip'
          })
        }
      };
      return clone(this.activeEdit.workingCopy);
    }
    this.commit({ ...this.config, components: this.config.components.map(item => item.instanceId === instanceId ? nextComponent : item) });
    return clone(nextComponent);
  }

  isEditing(instanceId) {
    return this.activeEdit?.instanceId === instanceId;
  }

  beginEdit(instanceId, sessionId) {
    if (this.activeEdit) throw new CatalogStateError('EDIT_IN_PROGRESS', 'an edit transaction is already active');
    if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 96) throw new CatalogStateError('INVALID_SESSION', 'session id is invalid');
    const component = findComponent(this.config, instanceId);
    if (!component) throw new CatalogStateError('COMPONENT_NOT_FOUND', 'component instance does not exist');
    if (!component.visible) throw new CatalogStateError('COMPONENT_HIDDEN', 'hidden component cannot enter edit mode');
    this.activeEdit = { sessionId, instanceId, windowGeneration: 1, workingCopy: clone(component) };
    return { sessionId, instanceId, windowGeneration: 1, workingCopy: clone(component) };
  }

  updateEdit(sessionId, patch) {
    if (!this.activeEdit || this.activeEdit.sessionId !== sessionId) throw new CatalogStateError('STALE_SESSION', 'edit session is not active');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CatalogStateError('INVALID_EDIT_PATCH', 'edit patch must be an object');
    const allowed = new Set(['displayName', 'visible', 'locked', 'displayId', 'bounds', 'theme', 'config']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new CatalogStateError('INVALID_EDIT_PATCH', `field ${key} cannot be edited here`);
    const next = { ...this.activeEdit.workingCopy, ...clone(patch) };
    if (patch.config && typeof patch.config === 'object' && !Array.isArray(patch.config)) {
      next.config = { ...this.activeEdit.workingCopy.config, ...clone(patch.config) };
    }
    const workingCopy = normalizeComponent(next);
    this.activeEdit = { ...this.activeEdit, workingCopy };
    return clone(workingCopy);
  }

  completeEdit(sessionId) {
    if (!this.activeEdit || this.activeEdit.sessionId !== sessionId) throw new CatalogStateError('STALE_SESSION', 'edit session is not active');
    const { instanceId, workingCopy } = this.activeEdit;
    if (!findComponent(this.config, instanceId)) {
      this.activeEdit = null;
      throw new CatalogStateError('COMPONENT_NOT_FOUND', 'edited component no longer exists');
    }
    const next = { ...this.config, components: this.config.components.map(component => component.instanceId === instanceId ? normalizeComponent(workingCopy) : component) };
    this.activeEdit = null;
    this.commit(next);
    return this.getConfig();
  }

  cancelEdit(sessionId) {
    if (!this.activeEdit || this.activeEdit.sessionId !== sessionId) throw new CatalogStateError('STALE_SESSION', 'edit session is not active');
    this.activeEdit = null;
    return this.getConfig();
  }
}

module.exports = { CatalogState, CatalogStateError, CATALOG_DEFINITIONS };
