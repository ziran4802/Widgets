const { CatalogState, CatalogStateError } = require('./catalog-state');
const { migrateDailyTodo, migrateLegacyCodexQuotaBounds } = require('./config-contract');

class AppServiceError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'AppServiceError';
    this.code = code;
  }
}

function publicError(code, message) {
  return { code, message };
}

class AppService {
  constructor({ store, now = () => new Date() } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new TypeError('store with load/save is required');
    this.store = store;
    this.now = now;
    this.phase = 'booting';
    this.configSource = undefined;
    this.lastError = undefined;
    this.catalog = undefined;
  }

  async start() {
    if (this.catalog) return this.snapshot();
    const loaded = await this.store.load();
    const quotaMigration = migrateLegacyCodexQuotaBounds(loaded.config);
    const todoMigration = migrateDailyTodo(quotaMigration.config, this.now());
    let config = todoMigration.config;
    let migrationError;
    if ((quotaMigration.changed || todoMigration.changed) && loaded.source === 'primary') {
      try {
        const saved = await this.store.save(config, this.now());
        config = saved.config;
      } catch (error) {
        migrationError = publicError(error.code || 'CONFIG_WRITE_FAILED', '额度组件尺寸已在本次运行升级，但未能写回配置');
      }
    }
    this.catalog = new CatalogState(config, { now: this.now });
    this.configSource = loaded.source;
    if (migrationError) {
      this.phase = 'degraded';
      this.lastError = migrationError;
    } else if (loaded.source === 'primary') {
      this.phase = 'ready';
      this.lastError = undefined;
    } else if (loaded.source === 'backup') {
      this.phase = 'degraded';
      this.lastError = publicError('CONFIG_RECOVERED_FROM_BACKUP', '使用备份配置，保存后可修复主配置');
    } else {
      this.phase = 'degraded';
      this.lastError = publicError('CONFIG_RECOVERY_REQUIRED', '配置不可用，已使用空配置');
    }
    return this.snapshot();
  }

  ensureStarted() {
    if (!this.catalog) throw new AppServiceError('NOT_STARTED', 'app service is not started');
  }

  snapshot() {
    this.ensureStarted();
    return {
      app: {
        phase: this.phase,
        configRevision: this.catalog.revision,
        configSource: this.configSource,
        lastError: this.lastError ? { ...this.lastError } : undefined
      },
      catalog: this.catalog.getSnapshot()
    };
  }

  async saveCandidate(candidate) {
    try {
      await this.store.save(candidate.getConfig(), this.now());
    } catch (error) {
      this.phase = 'degraded';
      this.lastError = publicError(error.code || 'CONFIG_WRITE_FAILED', '配置保存失败，已保留原配置');
      throw new AppServiceError(error.code || 'CONFIG_WRITE_FAILED', 'configuration save failed', error);
    }
    this.catalog = candidate;
    this.configSource = 'primary';
    this.phase = 'ready';
    this.lastError = undefined;
    return this.snapshot();
  }

  async addComponent(type) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    const component = candidate.addComponent(type);
    await this.saveCandidate(candidate);
    return component;
  }

  async removeComponent(instanceId) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    candidate.removeComponent(instanceId);
    await this.saveCandidate(candidate);
    return this.snapshot();
  }

  async setVisible(instanceId, visible) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    const component = candidate.setVisible(instanceId, visible);
    await this.saveCandidate(candidate);
    return component;
  }

  async updateNoteContent(instanceId, content) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    const component = candidate.setNoteContent(instanceId, content);
    await this.saveCandidate(candidate);
    return component;
  }

  async updateTodoItems(instanceId, state) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    const component = candidate.setTodoItems(instanceId, state);
    await this.saveCandidate(candidate);
    return component;
  }

  async updateSettings(patch) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    const settings = candidate.setSettings(patch);
    await this.saveCandidate(candidate);
    return settings;
  }

  async setPosition(instanceId, position) {
    this.ensureStarted();
    if (this.catalog.isEditing(instanceId)) return this.catalog.setPosition(instanceId, position);
    const candidate = this.catalog.cloneForTransaction();
    const component = candidate.setPosition(instanceId, position);
    await this.saveCandidate(candidate);
    return component;
  }

  beginEdit(instanceId, sessionId) {
    this.ensureStarted();
    return this.catalog.beginEdit(instanceId, sessionId);
  }

  updateEdit(sessionId, patch) {
    this.ensureStarted();
    return this.catalog.updateEdit(sessionId, patch);
  }

  async completeEdit(sessionId) {
    this.ensureStarted();
    const candidate = this.catalog.cloneForTransaction();
    candidate.completeEdit(sessionId);
    return this.saveCandidate(candidate);
  }

  cancelEdit(sessionId) {
    this.ensureStarted();
    return this.catalog.cancelEdit(sessionId);
  }
}

module.exports = { AppService, AppServiceError, CatalogStateError };
