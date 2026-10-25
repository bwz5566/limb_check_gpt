import test from 'node:test';
import assert from 'node:assert/strict';
import { deadline } from '../web/src/async.js';

test('pending startup times out and disposes a late stream', async () => {
  let resolve, disposed = false;
  const stream = new Promise(r => { resolve = r; });
  await assert.rejects(deadline(stream, 5, 'timeout', () => { disposed = true; }), /timeout/);
  resolve({});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(disposed, true);
});
test('successful startup does not dispose the active stream', async () => {
  let disposed = false;
  assert.equal(await deadline(Promise.resolve('ok'), 100, 'timeout', () => { disposed = true; }), 'ok');
  assert.equal(disposed, false);
});
