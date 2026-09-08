const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizedConfig, timeOptions, formatTime, formatDate } = require('../src/widget-clock');

test('normalizes clock format and seconds defaults', () => {
  assert.deepEqual(normalizedConfig(), { format: '24h', showSeconds: true });
  assert.deepEqual(normalizedConfig({ format: '12h', showSeconds: false }), { format: '12h', showSeconds: false });
  assert.deepEqual(normalizedConfig({ format: 'unsupported', showSeconds: 0 }), { format: '24h', showSeconds: true });
  assert.deepEqual(timeOptions({ format: '24h', showSeconds: false }), { hour: '2-digit', minute: '2-digit', hour12: false });
  assert.deepEqual(timeOptions({ format: '12h', showSeconds: true }), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
});

test('formats a local clock and full Chinese date from component settings', () => {
  const date = new Date('2026-09-07T13:05:09');
  const withoutSeconds = formatTime(date, { format: '24h', showSeconds: false });
  const withSeconds = formatTime(date, { format: '24h', showSeconds: true });
  assert.match(withoutSeconds, /^13:05/);
  assert.match(withSeconds, /^13:05:09/);
  assert.match(formatDate(date), /2026/);
  assert.match(formatDate(date), /9月/);
  assert.match(formatDate(date), /7日/);
});
