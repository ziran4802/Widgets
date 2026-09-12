const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REFRESH_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_FILENAME = 'codex-quota-cache.json';
const FIVE_HOUR_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

function resolveCodexExecutable({ platform = process.platform, env = process.env, existsSync = fs.existsSync, readdirSync = fs.readdirSync } = {}) {
  if (typeof env.WIDGET_CODEX_EXECUTABLE === 'string' && env.WIDGET_CODEX_EXECUTABLE.trim()) return env.WIDGET_CODEX_EXECUTABLE.trim();
  if (platform !== 'win32') return 'codex';
  const binRoot = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()
    ? path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    : undefined;
  if (binRoot) {
    try {
      const entries = readdirSync(binRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory?.()) continue;
        const candidate = path.join(binRoot, entry.name, 'codex.exe');
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return 'codex.exe';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function normalizeTimestamp(value) {
  const number = finiteNumber(value);
  if (number !== null && number > 0) return number > 100000000000 ? Math.floor(number / 1000) : Math.floor(number);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function normalizeWindow(value, fallbackDuration) {
  if (!isObject(value)) return null;
  const usedValue = finiteNumber(value.usedPercent ?? value.used_percentage ?? value.usedPercentage);
  const remainingValue = finiteNumber(value.remainingPercent ?? value.remaining_percentage ?? value.remainingPercentage);
  if (usedValue === null && remainingValue === null) return null;
  const remainingPercent = remainingValue === null ? clampPercent(100 - usedValue) : clampPercent(remainingValue);
  const usedPercent = usedValue === null ? clampPercent(100 - remainingPercent) : clampPercent(usedValue);
  const windowDurationMins = finiteNumber(value.windowDurationMins ?? value.window_duration_mins ?? value.durationMins) || fallbackDuration;
  return {
    phase: 'available',
    remainingPercent,
    usedPercent,
    windowDurationMins,
    resetsAt: normalizeTimestamp(value.resetsAt ?? value.resetAt ?? value.resets_at ?? value.reset_at)
  };
}

function rateLimitContainer(result) {
  if (!isObject(result)) return undefined;
  return result.rateLimits || result.rate_limits || result.account?.rateLimits || result.account?.rate_limits || result;
}

function valuesOf(container) {
  if (Array.isArray(container)) return container;
  if (!isObject(container)) return [];
  return Object.values(container).filter(isObject);
}

function pickWindow(container, names, duration) {
  if (!isObject(container) && !Array.isArray(container)) return null;
  if (isObject(container)) {
    for (const name of names) {
      const candidate = normalizeWindow(container[name], duration);
      if (candidate) return candidate;
    }
  }
  const matching = valuesOf(container).find(value => finiteNumber(value.windowDurationMins ?? value.window_duration_mins ?? value.durationMins) === duration);
  return normalizeWindow(matching, duration);
}

function normalizeRateLimitsResponse(message, now = new Date()) {
  const result = message?.result ?? message;
  const container = rateLimitContainer(result);
  const fiveHour = pickWindow(container, ['primary', 'fiveHour', 'five_hour', 'fiveHourWindow', 'primaryWindow'], FIVE_HOUR_MINUTES);
  const weekly = pickWindow(container, ['secondary', 'weekly', 'week', 'weeklyWindow', 'secondaryWindow'], WEEK_MINUTES);
  if (!fiveHour && !weekly) {
    const error = new Error('Codex rate limits are unavailable');
    error.code = 'CODEX_QUOTA_UNAVAILABLE';
    throw error;
  }
  return {
    schemaVersion: 1,
    phase: 'available',
    source: 'local-app-server',
    updatedAt: now.toISOString(),
    message: '已同步',
    fiveHour,
    weekly
  };
}

function unavailableQuota(message = '暂时无法读取 Codex 额度', code = 'CODEX_QUOTA_UNAVAILABLE') {
  return {
    schemaVersion: 1,
    phase: 'unavailable',
    source: 'local-app-server',
    updatedAt: null,
    message,
    errorCode: code,
    fiveHour: null,
    weekly: null
  };
}

function normalizeCachedQuota(value) {
  if (!isObject(value) || value.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return undefined;
  const fiveHour = normalizeWindow(value.fiveHour, FIVE_HOUR_MINUTES);
  const weekly = normalizeWindow(value.weekly, WEEK_MINUTES);
  if (!fiveHour && !weekly) return undefined;
  return {
    schemaVersion: 1,
    phase: 'available',
    source: 'local-cache',
    cacheState: 'cached',
    updatedAt: value.updatedAt,
    message: '上次确认',
    fiveHour,
    weekly
  };
}

function quotaCachePayload(snapshot) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: snapshot.updatedAt,
    fiveHour: snapshot.fiveHour,
    weekly: snapshot.weekly
  };
}

function hasQuotaData(snapshot) {
  return Boolean(snapshot?.fiveHour || snapshot?.weekly);
}

function readAppServerQuota({ spawnProcess = spawn, executable = resolveCodexExecutable(), timeoutMs = DEFAULT_TIMEOUT_MS, onProcess } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      onProcess?.(child);
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = '';
    let settled = false;
    let initialized = false;
    const timer = setTimeout(() => {
      const error = new Error('Codex app-server timed out');
      error.code = 'CODEX_QUOTA_TIMEOUT';
      finish(error);
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill?.(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const send = message => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { finish(error); }
    };
    const handleMessage = message => {
      if (message?.id === 1) {
        if (initialized) return;
        initialized = true;
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        const error = new Error('Codex app-server rejected the quota request');
        error.code = 'CODEX_QUOTA_REQUEST_FAILED';
        finish(error);
        return;
      }
      try { finish(null, normalizeRateLimitsResponse(message)); } catch (error) { finish(error); }
    };
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleMessage(JSON.parse(line)); } catch {
          const error = new Error('Codex app-server returned invalid data');
          error.code = 'CODEX_QUOTA_PROTOCOL_FAILED';
          finish(error);
        }
      }
    });
    child.on?.('error', error => finish(error));
    child.on?.('exit', (code, signal) => {
      if (settled) return;
      const error = new Error('Codex app-server exited before returning quota');
      error.code = code === 0 ? 'CODEX_QUOTA_UNAVAILABLE' : signal ? 'CODEX_QUOTA_INTERRUPTED' : 'CODEX_QUOTA_REQUEST_FAILED';
      finish(error);
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'widget-quota', title: 'Widget Codex Quota', version: '0.1.0' } }
    });
  });
}

function errorMessage(error) {
  if (error?.code === 'ENOENT') return ['未找到本机 Codex', 'CODEX_NOT_FOUND'];
  if (error?.code === 'CODEX_QUOTA_TIMEOUT') return ['读取超时', error.code];
  if (error?.code === 'CODEX_QUOTA_UNAVAILABLE') return ['Codex 额度暂不可用', error.code];
  if (error?.code === 'CODEX_QUOTA_PROTOCOL_FAILED') return ['读取协议不可用', error.code];
  return ['无法读取 Codex 额度', error?.code || 'CODEX_QUOTA_REQUEST_FAILED'];
}

class CodexQuotaService extends EventEmitter {
  constructor({ intervalMs = DEFAULT_REFRESH_MS, timeoutMs = DEFAULT_TIMEOUT_MS, executable, spawnProcess, fixture, now = () => new Date(), cachePath } = {}) {
    super();
    if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new TypeError('intervalMs must be at least 1000ms');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500) throw new TypeError('timeoutMs must be at least 500ms');
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.executable = executable || resolveCodexExecutable();
    this.spawnProcess = spawnProcess || spawn;
    this.fixture = fixture;
    this.now = now;
    this.cachePath = typeof cachePath === 'string' && cachePath.trim() ? path.resolve(cachePath) : undefined;
    this.cacheTempPath = this.cachePath ? `${this.cachePath}.tmp` : undefined;
    this.timer = undefined;
    this.started = false;
    this.pending = false;
    this.activeProcess = undefined;
    this.current = { ...unavailableQuota('等待读取', 'CODEX_QUOTA_IDLE'), phase: 'idle' };
  }

  snapshot() {
    return clone(this.current);
  }

  async start() {
    if (this.started) return this.snapshot();
    this.started = true;
    const cached = await this.readCache();
    if (cached) {
      this.current = cached;
      this.emit('update', this.snapshot());
    }
    return this.snapshot();
  }

  async refresh() {
    if (this.pending) return this.snapshot();
    this.pending = true;
    const previous = this.current;
    this.current = { ...previous, phase: 'loading', message: '正在确认', errorCode: undefined };
    this.emit('update', this.snapshot());
    try {
      const result = this.fixture === undefined
        ? await readAppServerQuota({ executable: this.executable, spawnProcess: this.spawnProcess, timeoutMs: this.timeoutMs, onProcess: process => { this.activeProcess = process; } })
        : normalizeRateLimitsResponse({ result: { rateLimits: this.fixture } }, this.now());
      this.current = { ...result, cacheState: 'fresh' };
      try {
        await this.writeCache(this.current);
      } catch {}
      if (this.started || this.fixture !== undefined) {
        this.emit('update', this.snapshot());
      }
      return this.snapshot();
    } catch (error) {
      const [message, code] = errorMessage(error);
      this.current = hasQuotaData(previous)
        ? { ...previous, phase: 'stale', cacheState: 'stale', message: `${message}，显示上次结果`, errorCode: code }
        : unavailableQuota(message, code);
      if (this.started || this.fixture !== undefined) this.emit('update', this.snapshot());
      return this.snapshot();
    } finally {
      this.pending = false;
      this.activeProcess = undefined;
    }
  }

  async readCache() {
    if (!this.cachePath) return undefined;
    try {
      const text = await fs.promises.readFile(this.cachePath, 'utf8');
      return normalizeCachedQuota(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  async writeCache(snapshot) {
    if (!this.cachePath || !this.cacheTempPath || snapshot?.phase !== 'available' || snapshot?.cacheState !== 'fresh') return;
    const serialized = `${JSON.stringify(quotaCachePayload(snapshot), null, 2)}\n`;
    await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.promises.rm(this.cacheTempPath, { force: true });
    await fs.promises.writeFile(this.cacheTempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.promises.rename(this.cacheTempPath, this.cachePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await fs.promises.rm(this.cachePath, { force: true });
      await fs.promises.rename(this.cacheTempPath, this.cachePath);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    try { this.activeProcess?.kill?.(); } catch {}
    this.activeProcess = undefined;
    this.pending = false;
  }
}

module.exports = {
  CodexQuotaService,
  DEFAULT_REFRESH_MS,
  DEFAULT_TIMEOUT_MS,
  FIVE_HOUR_MINUTES,
  WEEK_MINUTES,
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_FILENAME,
  normalizeRateLimitsResponse,
  normalizeCachedQuota,
  normalizeWindow,
  readAppServerQuota,
  unavailableQuota,
  resolveCodexExecutable
};
