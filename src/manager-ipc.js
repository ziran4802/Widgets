const { CatalogStateError } = require('./catalog-state');
const { AppServiceError } = require('./app-service');

const IPC_SCHEMA_VERSION = 1;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const COMMANDS = Object.freeze([
  'manager:get-snapshot',
  'manager:component-add',
  'manager:component-update',
  'manager:component-remove',
  'manager:settings-update',
  'manager:edit-begin',
  'manager:edit-update',
  'manager:edit-complete',
  'manager:edit-cancel'
]);

class ManagerIpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagerIpcError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateEnvelope(command, envelope) {
  if (!COMMANDS.includes(command)) throw new ManagerIpcError('INVALID_COMMAND', 'command is not supported');
  if (!isPlainObject(envelope)) throw new ManagerIpcError('INVALID_COMMAND', 'request envelope must be an object');
  if (envelope.schemaVersion !== IPC_SCHEMA_VERSION) throw new ManagerIpcError('INVALID_COMMAND', 'unsupported request schema');
  if (typeof envelope.requestId !== 'string' || !REQUEST_ID_PATTERN.test(envelope.requestId)) throw new ManagerIpcError('INVALID_COMMAND', 'request id is invalid');
  if (envelope.instanceId !== undefined && (typeof envelope.instanceId !== 'string' || envelope.instanceId.length > 96)) throw new ManagerIpcError('INVALID_COMMAND', 'instance id is invalid');
  if (envelope.sessionId !== undefined && (typeof envelope.sessionId !== 'string' || envelope.sessionId.length > 96)) throw new ManagerIpcError('INVALID_COMMAND', 'session id is invalid');
  if (envelope.payload !== undefined && !isPlainObject(envelope.payload)) throw new ManagerIpcError('INVALID_COMMAND', 'payload must be an object');
  return envelope;
}

function response(requestId, result) {
  return { schemaVersion: IPC_SCHEMA_VERSION, requestId, ...result };
}

function errorResponse(requestId, error) {
  const code = error?.code || 'INTERNAL_ERROR';
  const message = error instanceof ManagerIpcError || error instanceof CatalogStateError || error instanceof AppServiceError
    ? error.message
    : 'manager request failed';
  return response(requestId, { ok: false, errorCode: code, message });
}

function requireInstanceId(envelope) {
  if (typeof envelope.instanceId !== 'string' || envelope.instanceId.length === 0) throw new ManagerIpcError('INVALID_COMMAND', 'instance id is required');
  return envelope.instanceId;
}

function requireSessionId(envelope) {
  if (typeof envelope.sessionId !== 'string' || envelope.sessionId.length === 0) throw new ManagerIpcError('INVALID_COMMAND', 'session id is required');
  return envelope.sessionId;
}

class ManagerIpcRouter {
  constructor({ service, authorizeSender } = {}) {
    if (!service || typeof service.snapshot !== 'function') throw new TypeError('service is required');
    if (typeof authorizeSender !== 'function') throw new TypeError('authorizeSender is required');
    this.service = service;
    this.authorizeSender = authorizeSender;
  }

  async dispatch(context, command, envelope) {
    let requestId = typeof envelope?.requestId === 'string' && envelope.requestId.length <= 96 ? envelope.requestId : 'unknown';
    try {
      if (!this.authorizeSender(context)) throw new ManagerIpcError('UNAUTHORIZED_SENDER', 'request source is not authorized');
      const request = validateEnvelope(command, envelope);
      requestId = request.requestId;
      const payload = request.payload || {};
      if (command === 'manager:get-snapshot') return response(requestId, { ok: true, snapshot: this.service.snapshot() });
      if (command === 'manager:component-add') {
        if (typeof payload.type !== 'string') throw new ManagerIpcError('INVALID_COMMAND', 'component type is required');
        const component = await this.service.addComponent(payload.type);
        return response(requestId, { ok: true, component, snapshot: this.service.snapshot() });
      }
      if (command === 'manager:component-update') {
        const instanceId = requireInstanceId(request);
        if (payload.field !== 'visible' || typeof payload.value !== 'boolean') throw new ManagerIpcError('INVALID_COMMAND', 'only visible boolean updates are supported');
        const component = await this.service.setVisible(instanceId, payload.value);
        return response(requestId, { ok: true, component, snapshot: this.service.snapshot() });
      }
      if (command === 'manager:component-remove') {
        const instanceId = requireInstanceId(request);
        const snapshot = await this.service.removeComponent(instanceId);
        return response(requestId, { ok: true, snapshot });
      }
      if (command === 'manager:settings-update') {
        const settings = await this.service.updateSettings(payload.patch);
        return response(requestId, { ok: true, settings, snapshot: this.service.snapshot() });
      }
      if (command === 'manager:edit-begin') {
        const edit = this.service.beginEdit(requireInstanceId(request), requireSessionId(request));
        return response(requestId, { ok: true, edit, snapshot: this.service.snapshot() });
      }
      if (command === 'manager:edit-update') {
        const edit = this.service.updateEdit(requireSessionId(request), payload.patch);
        return response(requestId, { ok: true, edit, snapshot: this.service.snapshot() });
      }
      if (command === 'manager:edit-complete') {
        const snapshot = await this.service.completeEdit(requireSessionId(request));
        return response(requestId, { ok: true, snapshot });
      }
      if (command === 'manager:edit-cancel') {
        const snapshot = this.service.cancelEdit(requireSessionId(request));
        return response(requestId, { ok: true, snapshot });
      }
      throw new ManagerIpcError('INVALID_COMMAND', 'command is not supported');
    } catch (error) {
      return errorResponse(requestId || 'unknown', error);
    }
  }
}

module.exports = { IPC_SCHEMA_VERSION, COMMANDS, ManagerIpcError, ManagerIpcRouter, validateEnvelope };
