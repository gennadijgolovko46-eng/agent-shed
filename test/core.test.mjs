import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryPublicationLog,
  ShedError,
  applyLocalStep,
  checkpoint,
  createInitialState,
  markPublished,
  newLine,
  plannedShed,
  recover,
  sameState,
  validatePortableState
} from '../src/core.mjs';

const expectCode = (fn, code) => assert.throws(fn, error => error instanceof ShedError && error.code === code);

// 1
test('valid v0.1 portable state passes', () => {
  assert.equal(validatePortableState(createInitialState()), true);
});

// 2
test('missing required state field fails closed', () => {
  const s = createInitialState();
  delete s.task_id;
  expectCode(() => validatePortableState(s), 'INVALID_STATE');
});

// 3
test('prepare step is deterministic', () => {
  const a = applyLocalStep(createInitialState()).state;
  const b = applyLocalStep(createInitialState()).state;
  assert.ok(sameState(a, b));
  assert.equal(a.phase, 'compute');
});

// 4
test('compute yields verified demo result 377', () => {
  const prepared = applyLocalStep(createInitialState()).state;
  const computed = applyLocalStep(prepared).state;
  assert.equal(computed.result, 377);
  assert.equal(computed.phase, 'publish');
});

// 5
test('publish cannot be marked with wrong result', () => {
  const prepared = applyLocalStep(createInitialState()).state;
  const computed = applyLocalStep(prepared).state;
  expectCode(() => markPublished(computed, 378), 'RESULT_MISMATCH');
});

// 6
test('new line starts at epoch 1 on A', () => {
  const line = newLine(createInitialState(), 'A', 100, 50);
  assert.equal(line.epoch, 1);
  assert.equal(line.current_shell, 'A');
  assert.equal(line.lease_until, 150);
});

// 7
test('current shell checkpoint is accepted', () => {
  let line = newLine(createInitialState(), 'A', 0, 10);
  const state = applyLocalStep(line.state).state;
  line = checkpoint(line, { shell: 'A', epoch: 1, state, now: 1, leaseMs: 10 });
  assert.equal(line.state.phase, 'compute');
  assert.equal(line.lease_until, 11);
});

// 8
test('planned A to B shed increments epoch', () => {
  const line = plannedShed(newLine(createInitialState()), { fromShell: 'A', fromEpoch: 1, toShell: 'B', now: 5 });
  assert.equal(line.epoch, 2);
  assert.equal(line.current_shell, 'B');
});

// 9
test('A becomes STALE_EPOCH after A to B', () => {
  let line = newLine(createInitialState());
  line = plannedShed(line, { fromShell: 'A', fromEpoch: 1, toShell: 'B' });
  expectCode(() => checkpoint(line, { shell: 'A', epoch: 1, state: line.state }), 'STALE_EPOCH');
});

// 10
test('recovery is blocked while lease is active', () => {
  const line = newLine(createInitialState(), 'A', 100, 50);
  expectCode(() => recover(line, { claimantShell: 'B', now: 149 }), 'LEASE_ACTIVE');
});

// 11
test('expired A lease can recover only to B', () => {
  const line = newLine(createInitialState(), 'A', 0, 10);
  expectCode(() => recover(line, { claimantShell: 'C', now: 11 }), 'INVALID_SUCCESSOR');
  const recovered = recover(line, { claimantShell: 'B', now: 11 });
  assert.equal(recovered.epoch, 2);
  assert.equal(recovered.current_shell, 'B');
});

// 12
test('first publication happens exactly once', () => {
  const log = new MemoryPublicationLog();
  const r = log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 3, currentEpoch: 3, value: 377 });
  assert.equal(r.status, 'PUBLISHED');
  assert.equal(log.get('L', 'publish-result').count, 1);
});

// 13
test('lost acknowledgement retry is idempotent', () => {
  const log = new MemoryPublicationLog();
  log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 3, currentEpoch: 3, value: 377 });
  const retry = log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 3, currentEpoch: 3, value: 377 });
  assert.equal(retry.status, 'ALREADY_PUBLISHED');
  assert.equal(log.get('L', 'publish-result').count, 1);
});

// 14
test('same operation id with different bytes is rejected', () => {
  const log = new MemoryPublicationLog();
  log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 3, currentEpoch: 3, value: 377 });
  expectCode(() => log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 3, currentEpoch: 3, value: 378 }), 'OPERATION_CONFLICT');
});

// 15
test('stale epoch cannot publish even after operation exists', () => {
  const log = new MemoryPublicationLog();
  log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 3, currentEpoch: 3, value: 377 });
  expectCode(() => log.publish({ lineId: 'L', operationId: 'publish-result', epoch: 2, currentEpoch: 3, value: 377 }), 'STALE_EPOCH');
});

// 16
test('cloud-shaped A to B to C line finishes with one publication', () => {
  const log = new MemoryPublicationLog();
  let line = newLine(createInitialState({ lineId: 'cloud-demo' }), 'A', 0, 10);

  // A prepares, then sheds to B.
  line = checkpoint(line, { shell: 'A', epoch: 1, state: applyLocalStep(line.state).state, now: 1, leaseMs: 10 });
  line = plannedShed(line, { fromShell: 'A', fromEpoch: 1, toShell: 'B', now: 2, leaseMs: 10 });

  // B computes, then disappears.
  line = checkpoint(line, { shell: 'B', epoch: 2, state: applyLocalStep(line.state).state, now: 3, leaseMs: 10 });

  // C recovers after B lease expires.
  line = recover(line, { claimantShell: 'C', now: 14, leaseMs: 10 });
  const ext = applyLocalStep(line.state);
  assert.equal(ext.kind, 'external');
  assert.equal(ext.value, 377);
  log.publish({ lineId: line.line_id, operationId: ext.operation_id, epoch: 3, currentEpoch: line.epoch, value: ext.value });
  const done = markPublished(line.state, ext.value);
  line = checkpoint(line, { shell: 'C', epoch: 3, state: done, now: 15, leaseMs: 10 });

  assert.equal(line.state.result, 377);
  assert.equal(line.status, 'DONE');
  assert.equal(log.get(line.line_id, 'publish-result').count, 1);
});

// 17
test('returned A and B are stale after C takeover', () => {
  let line = newLine(createInitialState(), 'A', 0, 10);
  line = plannedShed(line, { fromShell: 'A', fromEpoch: 1, toShell: 'B', now: 1, leaseMs: 10 });
  line = recover(line, { claimantShell: 'C', now: 12, leaseMs: 10 });
  expectCode(() => checkpoint(line, { shell: 'A', epoch: 1, state: line.state }), 'STALE_EPOCH');
  expectCode(() => checkpoint(line, { shell: 'B', epoch: 2, state: line.state }), 'STALE_EPOCH');
});
