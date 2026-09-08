const test = require('node:test');
const assert = require('node:assert/strict');
const { LifecycleQueueError, OperationQueue, isSilentAutostart, secondInstanceAction } = require('../src/manager-lifecycle');

test('classifies manual and silent autostart second instances', () => {
  assert.equal(isSilentAutostart(['Widget.exe', '--autostart']), true);
  assert.equal(isSilentAutostart(['Widget.exe', '--silent-autostart']), true);
  assert.equal(isSilentAutostart(['Widget.exe', '--manager']), false);
  assert.equal(secondInstanceAction(['Widget.exe', '--manager']), 'focus');
  assert.equal(secondInstanceAction(['Widget.exe', '--autostart']), 'ignore');
});

test('operation queue serializes in-flight work and rejects new work after shutdown starts', async () => {
  const queue = new OperationQueue();
  const order = [];
  const first = queue.enqueue(async () => {
    order.push('first-start');
    await Promise.resolve();
    order.push('first-end');
    return 1;
  });
  const second = queue.enqueue(async () => {
    order.push('second');
    return 2;
  });
  queue.stopAccepting();
  await assert.rejects(queue.enqueue(() => 3), error => error instanceof LifecycleQueueError && error.code === 'APP_EXITING');
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  await queue.wait();
});
