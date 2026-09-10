const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageModel, normalizePageSize } = require('../src/manager-pagination');

test('normalizes invalid page sizes without producing an empty page', () => {
  assert.equal(normalizePageSize(0), 1);
  assert.equal(normalizePageSize('2.8'), 2);
  assert.equal(normalizePageSize(Number.NaN), 1);
});

test('paginates a catalog and keeps a short final page at the same page size', () => {
  const items = ['system-monitor', 'clock-date', 'note', 'daily-todo', 'codex-quota'];
  const first = createPageModel(items, 3, 0);
  const last = createPageModel(items, 3, 1);
  assert.deepEqual(first.items, items.slice(0, 3));
  assert.deepEqual(last.items, items.slice(3));
  assert.equal(first.pageCount, 2);
  assert.equal(last.pageSize, 3);
  assert.equal(first.hasNext, true);
  assert.equal(last.hasPrevious, true);
  assert.equal(last.hasNext, false);
});

test('clamps the current page after items are removed and handles an empty list', () => {
  assert.equal(createPageModel(['a', 'b', 'c', 'd'], 3, 99).currentPage, 1);
  const empty = createPageModel([], 3, 1);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.currentPage, 0);
  assert.equal(empty.hasPrevious, false);
  assert.equal(empty.hasNext, false);
});
