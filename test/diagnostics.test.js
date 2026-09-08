const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProbeRunId, safeValue, appendJsonLine, sanitizeReason } = require('../src/diagnostics');

test('diagnostics serialize handles and append one JSON line', () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'widget-m0-')), 'nested', 'probe.jsonl');
  const runId = createProbeRunId(new Date('2026-09-06T00:00:00.000Z'));
  assert.equal(runId, 'M0-20260906T000000Z');
  appendJsonLine(target, { runId, handle: 42n, nested: { value: 1 } });
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(value, { runId, handle: '0x2a', nested: { value: 1 } });
});

test('diagnostics sanitize internal-looking values', () => {
  assert.match(sanitizeReason('C:\\private\\path\\file.txt 123456'), /\[path\]/);
  assert.doesNotMatch(sanitizeReason('C:\\private\\path\\file.txt 123456'), /123456/);
  assert.deepEqual(safeValue({ handle: 5n }), { handle: '0x5' });
});
