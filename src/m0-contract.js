const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeDipBounds(value) {
  if (!value || typeof value !== 'object' || ![value.x, value.y, value.width, value.height].every(finite) || value.width <= 0 || value.height <= 0) {
    throw new TypeError('bounds must contain finite positive x/y/width/height values');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height, unit: 'dip' };
}

function dipToPhysical(value, scaleFactor) {
  const bounds = normalizeDipBounds(value);
  if (!finite(scaleFactor) || scaleFactor <= 0) throw new TypeError('scaleFactor must be positive');
  const x = Math.round(bounds.x * scaleFactor);
  const y = Math.round(bounds.y * scaleFactor);
  const width = Math.round(bounds.width * scaleFactor);
  const height = Math.round(bounds.height * scaleFactor);
  return { left: x, top: y, right: x + width, bottom: y + height, width, height, unit: 'physical' };
}

function rectToBounds(rect) {
  if (!rect || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isInteger)) return undefined;
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, unit: rect.unit };
}

function withinTolerance(actual, expected, tolerance = 1) {
  if (!actual || !expected || !Number.isInteger(tolerance) || tolerance < 0) return false;
  return ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(actual[key]) && Number.isFinite(expected[key]) && Math.abs(actual[key] - expected[key]) <= tolerance);
}

function classifyObservation(observation, tolerance = 1) {
  if (!observation || typeof observation !== 'object') return { result: RESULT.INCONCLUSIVE, reasons: ['observation missing'] };
  if (observation.nativeAvailable === false) return { result: RESULT.INCONCLUSIVE, reasons: [observation.nativeReason || 'native adapter unavailable'] };
  const reasons = [];
  if (observation.success === false) reasons.push(...(Array.isArray(observation.errors) ? observation.errors : ['operation failed']));
  if (observation.structureValid === false) reasons.push('native structure validation failed');
  if (observation.clientValid === false) reasons.push('native client geometry validation failed');
  if (observation.expectedPhysical && observation.actualClient && !withinTolerance(observation.actualClient, observation.expectedPhysical, tolerance)) reasons.push('client geometry outside tolerance');
  if (reasons.length > 0) return { result: RESULT.FAIL, reasons: [...new Set(reasons)] };
  if (observation.success !== true) return { result: RESULT.INCONCLUSIVE, reasons: ['operation did not provide a successful native observation'] };
  if (observation.expectedPhysical && !observation.actualClient) return { result: RESULT.INCONCLUSIVE, reasons: ['client geometry observation missing'] };
  return { result: RESULT.PASS, reasons: [] };
}

module.exports = { RESULT, normalizeDipBounds, dipToPhysical, rectToBounds, withinTolerance, classifyObservation };
