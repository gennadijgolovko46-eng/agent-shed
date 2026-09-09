export const STATE_SCHEMA = 'shed-state/0.1';
export const LINE_SCHEMA = 'shed-line/0.1';
export const DEFAULT_LEASE_MS = 15_000;
export const SHELL_ORDER = Object.freeze(['A', 'B', 'C']);

export class ShedError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ShedError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => { throw new ShedError(code, message, details); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const stable = value => JSON.stringify(value, Object.keys(value).sort());

export function validatePortableState(state) {
  if (!isObject(state)) fail('INVALID_STATE', 'State must be an object.');
  if (state.schema_version !== STATE_SCHEMA) fail('UNSUPPORTED_SCHEMA', `Expected ${STATE_SCHEMA}.`);
  for (const key of ['line_id', 'task_id', 'phase']) {
    if (typeof state[key] !== 'string' || state[key].length === 0) fail('INVALID_STATE', `Missing ${key}.`);
  }
  if (!['prepare', 'compute', 'publish', 'done'].includes(state.phase)) fail('INVALID_PHASE', 'Unknown phase.');
  if (!isObject(state.objective) || state.objective.kind !== 'multiply') fail('INVALID_OBJECTIVE', 'v0.1 supports multiply objective only.');
  if (!Number.isSafeInteger(state.objective.a) || !Number.isSafeInteger(state.objective.b)) fail('INVALID_OBJECTIVE', 'Objective operands must be safe integers.');
  if (!isObject(state.artifacts) || typeof state.artifacts.prepared !== 'boolean') fail('INVALID_STATE', 'Missing artifacts.prepared.');
  if (!(state.result === null || Number.isSafeInteger(state.result))) fail('INVALID_STATE', 'result must be null or a safe integer.');
  if (!isObject(state.operations) || !isObject(state.operations['publish-result'])) fail('INVALID_STATE', 'Missing publish-result operation.');
  const op = state.operations['publish-result'];
  if (!['pending', 'done'].includes(op.status)) fail('INVALID_STATE', 'Invalid publish-result status.');
  if (!(op.value === null || Number.isSafeInteger(op.value))) fail('INVALID_STATE', 'Invalid publish-result value.');
  if (!Array.isArray(state.history)) fail('INVALID_STATE', 'history must be an array.');
  return true;
}

export function createInitialState({ lineId = 'demo-line-001', taskId = 'demo-377', a = 13, b = 29 } = {}) {
  const state = {
    schema_version: STATE_SCHEMA,
    line_id: lineId,
    task_id: taskId,
    phase: 'prepare',
    objective: { kind: 'multiply', a, b },
    artifacts: { prepared: false },
    result: null,
    operations: {
      'publish-result': { status: 'pending', value: null }
    },
    history: []
  };
  validatePortableState(state);
  return state;
}

export function applyLocalStep(input) {
  validatePortableState(input);
  const state = copy(input);
  if (state.phase === 'prepare') {
    state.artifacts.prepared = true;
    state.history.push({ event: 'prepared' });
    state.phase = 'compute';
    return { kind: 'local', state };
  }
  if (state.phase === 'compute') {
    if (!state.artifacts.prepared) fail('MISSING_ARTIFACT', 'Cannot compute before prepare.');
    state.result = state.objective.a * state.objective.b;
    state.history.push({ event: 'computed', result: state.result });
    state.phase = 'publish';
    return { kind: 'local', state };
  }
  if (state.phase === 'publish') {
    if (!Number.isSafeInteger(state.result)) fail('MISSING_RESULT', 'Cannot publish without result.');
    return {
      kind: 'external',
      operation_id: 'publish-result',
      value: state.result,
      state
    };
  }
  return { kind: 'done', state };
}

export function markPublished(input, value) {
  validatePortableState(input);
  const state = copy(input);
  if (state.phase !== 'publish') fail('INVALID_PHASE', 'State is not ready to publish.');
  if (state.result !== value) fail('RESULT_MISMATCH', 'Published value differs from state result.');
  state.operations['publish-result'] = { status: 'done', value };
  state.history.push({ event: 'published', operation_id: 'publish-result', value });
  state.phase = 'done';
  validatePortableState(state);
  return state;
}

export function nextShell(shell) {
  const i = SHELL_ORDER.indexOf(shell);
  return i >= 0 && i + 1 < SHELL_ORDER.length ? SHELL_ORDER[i + 1] : null;
}

export function newLine(state, shell = 'A', now = 0, leaseMs = DEFAULT_LEASE_MS) {
  validatePortableState(state);
  if (!SHELL_ORDER.includes(shell)) fail('INVALID_SHELL', 'Unsupported shell.');
  return {
    schema_version: LINE_SCHEMA,
    line_id: state.line_id,
    epoch: 1,
    current_shell: shell,
    lease_until: now + leaseMs,
    status: state.phase === 'done' ? 'DONE' : 'RUNNING',
    state: copy(state),
    events: [{ type: 'INIT', shell, epoch: 1, at: now }]
  };
}

export function assertAuthority(line, shell, epoch) {
  if (line.current_shell !== shell || line.epoch !== epoch) {
    fail('STALE_EPOCH', 'Execution shell no longer holds current authority.', {
      current_shell: line.current_shell,
      current_epoch: line.epoch,
      attempted_shell: shell,
      attempted_epoch: epoch
    });
  }
  return true;
}

export function checkpoint(lineInput, { shell, epoch, state, now = 0, leaseMs = DEFAULT_LEASE_MS }) {
  const line = copy(lineInput);
  assertAuthority(line, shell, epoch);
  validatePortableState(state);
  if (state.line_id !== line.line_id) fail('LINE_MISMATCH', 'Portable state belongs to a different line.');
  line.state = copy(state);
  line.status = state.phase === 'done' ? 'DONE' : 'RUNNING';
  line.lease_until = now + leaseMs;
  line.events.push({ type: 'CHECKPOINT', shell, epoch, phase: state.phase, at: now });
  return line;
}

export function plannedShed(lineInput, { fromShell, fromEpoch, toShell, now = 0, leaseMs = DEFAULT_LEASE_MS }) {
  const line = copy(lineInput);
  assertAuthority(line, fromShell, fromEpoch);
  if (line.status === 'DONE') fail('LINE_DONE', 'Completed line cannot shed.');
  if (nextShell(fromShell) !== toShell) fail('INVALID_SUCCESSOR', 'Successor is not allowed by v0.1 shell order.');
  line.epoch += 1;
  line.current_shell = toShell;
  line.lease_until = now + leaseMs;
  line.events.push({ type: 'SHED', from: fromShell, to: toShell, epoch: line.epoch, at: now });
  return line;
}

export function recover(lineInput, { claimantShell, now = 0, leaseMs = DEFAULT_LEASE_MS }) {
  const line = copy(lineInput);
  if (line.status === 'DONE') fail('LINE_DONE', 'Completed line needs no recovery.');
  if (now < line.lease_until) fail('LEASE_ACTIVE', 'Current shell lease has not expired.');
  const expected = nextShell(line.current_shell);
  if (expected === null) fail('NO_SUCCESSOR', 'No configured successor remains.');
  if (claimantShell !== expected) fail('INVALID_SUCCESSOR', 'Only the configured next shell may recover the line.');
  const from = line.current_shell;
  line.epoch += 1;
  line.current_shell = claimantShell;
  line.lease_until = now + leaseMs;
  line.events.push({ type: 'RECOVER', from, to: claimantShell, epoch: line.epoch, at: now });
  return line;
}

export class MemoryPublicationLog {
  constructor() {
    this.records = new Map();
  }

  publish({ lineId, operationId, epoch, currentEpoch, value }) {
    if (epoch !== currentEpoch) fail('STALE_EPOCH', 'Stale execution cannot publish.');
    const key = `${lineId}:${operationId}`;
    const payload = { lineId, operationId, value };
    const prior = this.records.get(key);
    if (!prior) {
      const record = { payload, count: 1 };
      this.records.set(key, record);
      return { status: 'PUBLISHED', count: 1 };
    }
    if (JSON.stringify(prior.payload) !== JSON.stringify(payload)) fail('OPERATION_CONFLICT', 'Operation id was already used for different bytes.');
    return { status: 'ALREADY_PUBLISHED', count: prior.count };
  }

  get(lineId, operationId) {
    return this.records.get(`${lineId}:${operationId}`) ?? null;
  }
}

export function sameState(a, b) {
  return stable(a) === stable(b);
}
