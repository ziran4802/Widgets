const fs = require('node:fs');
const path = require('node:path');

function createProbeRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `M0-${stamp}`;
}

function safeValue(value) {
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item)]));
  return value;
}

function appendJsonLine(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(safeValue(value))}\n`, 'utf8');
  return target;
}

function sanitizeReason(value) {
  return String(value || 'unknown')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^;\s]*)+/g, '[path]')
    .replace(/\b\d{5,}\b/g, '[number]')
    .slice(0, 240);
}

module.exports = { createProbeRunId, safeValue, appendJsonLine, sanitizeReason };
