class LifecycleQueueError extends Error {
  constructor(message = 'application is shutting down') {
    super(message);
    this.name = 'LifecycleQueueError';
    this.code = 'APP_EXITING';
  }
}

function isSilentAutostart(commandLine = []) {
  return Array.isArray(commandLine) && commandLine.some(argument => argument === '--autostart' || argument === '--silent-autostart');
}

function secondInstanceAction(commandLine = []) {
  return isSilentAutostart(commandLine) ? 'ignore' : 'focus';
}

class OperationQueue {
  constructor() {
    this.accepting = true;
    this.tail = Promise.resolve();
  }

  enqueue(operation) {
    if (!this.accepting) return Promise.reject(new LifecycleQueueError());
    if (typeof operation !== 'function') return Promise.reject(new TypeError('operation must be a function'));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  stopAccepting() {
    this.accepting = false;
  }

  wait() {
    return this.tail;
  }
}

module.exports = { LifecycleQueueError, OperationQueue, isSilentAutostart, secondInstanceAction };
