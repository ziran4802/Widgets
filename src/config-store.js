const fs = require('node:fs');
const path = require('node:path');
const { createDefaultConfig, normalizeConfig, clone } = require('./config-contract');

class ConfigStoreError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'ConfigStoreError';
    this.code = code;
  }
}

function describeReadError(error) {
  if (error && error.code === 'ENOENT') return { code: 'CONFIG_NOT_FOUND', message: 'configuration file not found' };
  if (error instanceof SyntaxError) return { code: 'CONFIG_INVALID_JSON', message: 'configuration is not valid JSON' };
  if (error && error.name === 'TypeError') return { code: 'CONFIG_INVALID', message: error.message };
  return { code: 'CONFIG_READ_FAILED', message: 'configuration could not be read' };
}

async function syncFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class ConfigStore {
  constructor({ filePath, backupPath, tempPath } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('filePath is required');
    this.filePath = path.resolve(filePath);
    this.backupPath = path.resolve(backupPath || `${this.filePath}.bak`);
    this.tempPath = path.resolve(tempPath || `${this.filePath}.tmp`);
  }

  async readCandidate(filePath) {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return normalizeConfig(JSON.parse(text));
  }

  async load() {
    const errors = [];
    try {
      return { source: 'primary', config: await this.readCandidate(this.filePath), errors };
    } catch (error) {
      errors.push({ source: 'primary', ...describeReadError(error) });
    }
    try {
      return { source: 'backup', config: await this.readCandidate(this.backupPath), errors, needsRepair: true };
    } catch (error) {
      errors.push({ source: 'backup', ...describeReadError(error) });
    }
    return { source: 'default', config: createDefaultConfig(), errors, needsRepair: true };
  }

  async save(config, now = new Date()) {
    let normalized;
    try {
      normalized = normalizeConfig({ ...clone(config), updatedAt: now.toISOString() });
    } catch (error) {
      throw new ConfigStoreError('CONFIG_INVALID', 'configuration failed validation', error);
    }
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    let backupCreated = false;
    try {
      await fs.promises.rm(this.tempPath, { force: true });
      await fs.promises.writeFile(this.tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
      await syncFile(this.tempPath);
      try {
        await fs.promises.copyFile(this.filePath, this.backupPath);
        backupCreated = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await fs.promises.rename(this.tempPath, this.filePath);
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
        await fs.promises.rm(this.filePath, { force: true });
        await fs.promises.rename(this.tempPath, this.filePath);
      }
      return { config: clone(normalized), filePath: this.filePath, backupPath: this.backupPath, backupCreated };
    } catch (error) {
      await fs.promises.rm(this.tempPath, { force: true }).catch(() => {});
      if (error instanceof ConfigStoreError) throw error;
      throw new ConfigStoreError('CONFIG_WRITE_FAILED', 'configuration could not be written', error);
    }
  }
}

module.exports = { ConfigStore, ConfigStoreError };
