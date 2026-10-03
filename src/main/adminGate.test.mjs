import test from 'node:test';
import assert from 'node:assert/strict';
import { passAdminGate } from './adminGate.ts';

for (const [status, proceeds] of [['elevated', true], ['not-elevated', false], ['unknown', true]]) {
  test(`packaged ${status}: ${proceeds ? 'continue' : 'notify then quit'}`, async () => {
    const calls = [];
    const result = await passAdminGate({
      isPackaged: true,
      probe: () => { calls.push('probe'); return status; },
      notify: () => calls.push('notify'),
      quit: () => calls.push('quit'),
    });
    if (result) calls.push('startup');
    assert.equal(result, proceeds);
    assert.deepEqual(calls, proceeds ? ['probe', 'startup'] : ['probe', 'notify', 'quit']);
  });
}

test('development skips the probe and continues', async () => {
  assert.equal(await passAdminGate({
    isPackaged: false,
    probe: () => assert.fail('development must not probe'),
    notify: () => assert.fail('unexpected notice'),
    quit: () => assert.fail('unexpected quit'),
  }), true);
});

for (const probe of [() => { throw new Error('binding failed'); }, async () => { throw new Error('probe failed'); }]) {
  test('probe exception fails open', async () => {
    assert.equal(await passAdminGate({
      isPackaged: true, probe,
      notify: () => assert.fail('unexpected notice'),
      quit: () => assert.fail('unexpected quit'),
    }), true);
  });
}

test('confirmed denial still quits when the dialog throws', async () => {
  let quit = false;
  await assert.rejects(passAdminGate({
    isPackaged: true,
    probe: () => 'not-elevated',
    notify: () => { throw new Error('dialog failed'); },
    quit: () => { quit = true; },
  }), /dialog failed/);
  assert.equal(quit, true);
});
