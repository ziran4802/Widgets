const test = require('node:test');
const assert = require('node:assert/strict');
const { RESULT, normalizeDipBounds, dipToPhysical, rectToBounds, withinTolerance, classifyObservation } = require('../src/m0-contract');

test('normalizes valid DIP bounds and rejects invalid bounds', () => {
  assert.deepEqual(normalizeDipBounds({ x: 10, y: 20, width: 360, height: 160 }), { x: 10, y: 20, width: 360, height: 160, unit: 'dip' });
  assert.throws(() => normalizeDipBounds({ x: 0, y: 0, width: 0, height: 160 }), /positive/);
});

test('converts DIP bounds to physical pixels without double conversion', () => {
  assert.deepEqual(dipToPhysical({ x: 776, y: 16, width: 360, height: 160 }, 1.65), { left: 1280, top: 26, right: 1874, bottom: 290, width: 594, height: 264, unit: 'physical' });
});

test('converts physical rect back to a bounds shape', () => {
  assert.deepEqual(rectToBounds({ left: 10, top: 20, right: 370, bottom: 180, unit: 'physical' }), { x: 10, y: 20, width: 360, height: 160, unit: 'physical' });
  assert.equal(rectToBounds({ left: 0, top: 0, right: 1.5, bottom: 2 }), undefined);
});

test('uses explicit geometry tolerance', () => {
  const expected = { left: 100, top: 200, right: 460, bottom: 360 };
  assert.equal(withinTolerance({ ...expected, right: 461 }, expected, 1), true);
  assert.equal(withinTolerance({ ...expected, right: 462 }, expected, 1), false);
});

test('classifies missing native adapter as inconclusive', () => {
  assert.deepEqual(classifyObservation({ nativeAvailable: false, nativeReason: 'koffi unavailable', success: false, errors: ['koffi unavailable'] }), { result: RESULT.INCONCLUSIVE, reasons: ['koffi unavailable'] });
});

test('classifies valid native client geometry as pass', () => {
  const geometry = { left: 100, top: 200, right: 460, bottom: 360 };
  assert.deepEqual(classifyObservation({ nativeAvailable: true, success: true, structureValid: true, clientValid: true, expectedPhysical: geometry, actualClient: { ...geometry, right: 461 } }), { result: RESULT.PASS, reasons: [] });
});

test('classifies native structure or geometry failure as fail', () => {
  assert.deepEqual(classifyObservation({ nativeAvailable: true, success: true, structureValid: false, clientValid: true, errors: [] }), { result: RESULT.FAIL, reasons: ['native structure validation failed'] });
  assert.deepEqual(classifyObservation({ nativeAvailable: true, success: true, structureValid: true, clientValid: false, errors: [] }), { result: RESULT.FAIL, reasons: ['native client geometry validation failed'] });
});
