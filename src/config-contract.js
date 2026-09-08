const CONFIG_SCHEMA_VERSION = 1;
const LAYOUT_VERSION = 1;
const MAX_COMPONENTS = 32;
const MAX_PRIVATE_CONFIG_BYTES = 16 * 1024;
const DEFAULT_GLOBAL_OPACITY = 0.92;
const COMPONENT_TYPES = Object.freeze(['system-monitor', 'clock-date', 'note', 'codex-quota']);
const THEMES = Object.freeze(['system', 'light', 'dark']);
const NOTE_SIZES = Object.freeze(['compact', 'standard', 'large']);
const NOTE_BACKGROUNDS = Object.freeze(['yellow', 'blue', 'green', 'pink']);

const COMPONENT_DEFINITIONS = Object.freeze({
  'system-monitor': Object.freeze({
    displayName: '系统监测',
    bounds: Object.freeze({ x: 16, y: 16, width: 520, height: 190, unit: 'dip' }),
    config: Object.freeze({})
  }),
  'clock-date': Object.freeze({
    displayName: '时钟 / 日期',
    bounds: Object.freeze({ x: 16, y: 192, width: 280, height: 128, unit: 'dip' }),
    config: Object.freeze({ format: '24h', showSeconds: true })
  }),
  note: Object.freeze({
    displayName: '便签',
    bounds: Object.freeze({ x: 320, y: 16, width: 300, height: 260, unit: 'dip' }),
    config: Object.freeze({ title: '', text: '', size: 'standard', background: 'yellow' })
  }),
  'codex-quota': Object.freeze({
    displayName: 'Codex 额度',
    bounds: Object.freeze({ x: 16, y: 336, width: 680, height: 300, unit: 'dip' }),
    config: Object.freeze({})
  })
});

const LEGACY_CODEX_QUOTA_BOUNDS = Object.freeze({ width: 520, height: 250 });

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value) {
  return Number.isInteger(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function checkPrivateValue(value, path, depth = 0) {
  if (depth > 8) fail(path, 'nested value is too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'number must be finite');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkPrivateValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) fail(path, 'value must be JSON-compatible');
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 80) fail(`${path}.${key}`, 'key is too long');
    checkPrivateValue(child, `${path}.${key}`, depth + 1);
  }
}

function normalizeBounds(value, path = 'bounds') {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!finite(value[key])) fail(`${path}.${key}`, 'must be finite');
  }
  if (value.width <= 0 || value.height <= 0) fail(path, 'width and height must be positive');
  if (value.width > 4096 || value.height > 4096) fail(path, 'width and height are too large');
  if (value.unit !== 'dip') fail(`${path}.unit`, 'must be dip');
  return { x: value.x, y: value.y, width: value.width, height: value.height, unit: 'dip' };
}

function normalizeTheme(value, path = 'theme') {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  if (!THEMES.includes(value.name)) fail(`${path}.name`, 'unknown theme');
  if (!finite(value.opacity) || value.opacity < 0.4 || value.opacity > 1) fail(`${path}.opacity`, 'must be between 0.4 and 1');
  return { name: value.name, opacity: value.opacity };
}

function normalizeNoteConfig(value, path = 'config') {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  const title = value.title === undefined ? '' : value.title;
  const text = value.text === undefined ? '' : value.text;
  const size = value.size === undefined ? 'standard' : value.size;
  const background = value.background === undefined ? 'yellow' : value.background;
  if (typeof title !== 'string' || title.length > 160) fail(`${path}.title`, 'must be text of at most 160 characters');
  if (typeof text !== 'string' || text.length > 12000) fail(`${path}.text`, 'must be plain text of at most 12000 characters');
  if (!NOTE_SIZES.includes(size)) fail(`${path}.size`, 'unknown note size');
  if (!NOTE_BACKGROUNDS.includes(background)) fail(`${path}.background`, 'unknown note background');
  return { title, text, size, background };
}

function normalizeSettings(value, path = 'settings') {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  const opacity = value.opacity === undefined ? DEFAULT_GLOBAL_OPACITY : value.opacity;
  if (!THEMES.includes(value.theme)) fail(`${path}.theme`, 'unknown theme');
  if (typeof value.globalLocked !== 'boolean') fail(`${path}.globalLocked`, 'must be boolean');
  if (!finite(opacity) || opacity < 0.4 || opacity > 1) fail(`${path}.opacity`, 'must be between 0.4 and 1');
  return { theme: value.theme, globalLocked: value.globalLocked, opacity };
}

function normalizeComponent(value, path = 'component') {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  if (typeof value.instanceId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.instanceId) || value.instanceId.length > 96) fail(`${path}.instanceId`, 'must be a stable kebab-case identifier');
  if (!COMPONENT_TYPES.includes(value.type)) fail(`${path}.type`, 'unknown component type');
  if (!integer(value.schemaVersion) || value.schemaVersion !== CONFIG_SCHEMA_VERSION) fail(`${path}.schemaVersion`, 'unsupported component schema');
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0 || value.displayName.length > 80) fail(`${path}.displayName`, 'must be a non-empty short string');
  if (typeof value.visible !== 'boolean') fail(`${path}.visible`, 'must be boolean');
  if (typeof value.locked !== 'boolean') fail(`${path}.locked`, 'must be boolean');
  if (value.displayId !== null && (typeof value.displayId !== 'string' || value.displayId.length > 256)) fail(`${path}.displayId`, 'must be null or a short string');
  const bounds = normalizeBounds(value.bounds, `${path}.bounds`);
  const theme = normalizeTheme(value.theme, `${path}.theme`);
  checkPrivateValue(value.config, `${path}.config`);
  const componentConfig = value.type === 'note' ? normalizeNoteConfig(value.config, `${path}.config`) : clone(value.config);
  const configBytes = Buffer.byteLength(JSON.stringify(componentConfig), 'utf8');
  if (configBytes > MAX_PRIVATE_CONFIG_BYTES) fail(`${path}.config`, 'private configuration is too large');
  return {
    instanceId: value.instanceId,
    type: value.type,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    displayName: value.displayName,
    visible: value.visible,
    locked: value.locked,
    displayId: value.displayId,
    bounds,
    theme,
    config: componentConfig
  };
}

function normalizeConfig(value) {
  if (!isPlainObject(value)) fail('config', 'must be an object');
  if (!integer(value.schemaVersion) || value.schemaVersion !== CONFIG_SCHEMA_VERSION) fail('schemaVersion', 'unsupported config schema');
  if (!integer(value.layoutVersion) || value.layoutVersion !== LAYOUT_VERSION) fail('layoutVersion', 'unsupported layout schema');
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) fail('updatedAt', 'must be a valid timestamp');
  const settings = normalizeSettings(value.settings);
  if (!Array.isArray(value.components)) fail('components', 'must be an array');
  if (value.components.length > MAX_COMPONENTS) fail('components', `cannot contain more than ${MAX_COMPONENTS} items`);
  const seen = new Set();
  const components = value.components.map((component, index) => {
    const normalized = normalizeComponent(component, `components[${index}]`);
    if (seen.has(normalized.instanceId)) fail(`components[${index}].instanceId`, 'must be unique');
    seen.add(normalized.instanceId);
    return normalized;
  });
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    layoutVersion: LAYOUT_VERSION,
    updatedAt: value.updatedAt,
    settings,
    components
  };
}

function createDefaultConfig(now = new Date()) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    layoutVersion: LAYOUT_VERSION,
    updatedAt: now.toISOString(),
    settings: { theme: 'system', globalLocked: true, opacity: DEFAULT_GLOBAL_OPACITY },
    components: []
  };
}

function createDefaultComponent(type, instanceId) {
  if (!COMPONENT_TYPES.includes(type)) fail('type', 'unknown component type');
  if (typeof instanceId !== 'string') fail('instanceId', 'must be a string');
  const definition = COMPONENT_DEFINITIONS[type];
  return normalizeComponent({
    instanceId,
    type,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    displayName: definition.displayName,
    visible: true,
    locked: true,
    displayId: null,
    bounds: definition.bounds,
    theme: { name: 'system', opacity: 0.92 },
    config: definition.config
  });
}

function migrateLegacyCodexQuotaBounds(config) {
  if (!isPlainObject(config) || !Array.isArray(config.components)) return { config, changed: false };
  let changed = false;
  const next = clone(config);
  next.components = next.components.map(component => {
    if (component.type !== 'codex-quota' || component.bounds.width !== LEGACY_CODEX_QUOTA_BOUNDS.width || component.bounds.height !== LEGACY_CODEX_QUOTA_BOUNDS.height) return component;
    changed = true;
    return {
      ...component,
      bounds: {
        ...component.bounds,
        width: COMPONENT_DEFINITIONS['codex-quota'].bounds.width,
        height: COMPONENT_DEFINITIONS['codex-quota'].bounds.height
      }
    };
  });
  return { config: changed ? next : config, changed };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  LAYOUT_VERSION,
  MAX_COMPONENTS,
  COMPONENT_TYPES,
  COMPONENT_DEFINITIONS,
  THEMES,
  DEFAULT_GLOBAL_OPACITY,
  NOTE_SIZES,
  NOTE_BACKGROUNDS,
  normalizeBounds,
  normalizeComponent,
  normalizeConfig,
  validateConfig: normalizeConfig,
  createDefaultConfig,
  createDefaultComponent,
  migrateLegacyCodexQuotaBounds,
  normalizeNoteConfig,
  normalizeSettings,
  clone
};
