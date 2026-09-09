import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_LEASE_MS,
  ShedError,
  applyLocalStep,
  checkpoint,
  createInitialState,
  markPublished,
  newLine,
  nextShell,
  plannedShed,
  recover,
  validatePortableState
} from './core.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const bodyJson = async request => {
  try { return await request.json(); }
  catch { throw new ShedError('INVALID_JSON', 'Request body must be JSON.'); }
};

const toError = error => {
  if (error instanceof ShedError) return json({ ok: false, error: error.code, message: error.message, details: error.details }, error.code === 'STALE_EPOCH' ? 409 : 400);
  console.error(error);
  return json({ ok: false, error: 'INTERNAL_ERROR' }, 500);
};

const parseLinePath = pathname => {
  const m = pathname.match(/^\/v0\/lines\/([^/]+)(?:\/(.*))?$/);
  return m ? { lineId: decodeURIComponent(m[1]), action: m[2] ?? '' } : null;
};

function assertCurrent(line, shell, epoch) {
  if (line.current_shell !== shell || line.epoch !== epoch) {
    throw new ShedError('STALE_EPOCH', 'Execution shell no longer holds current authority.', {
      current_shell: line.current_shell,
      current_epoch: line.epoch,
      attempted_shell: shell,
      attempted_epoch: epoch
    });
  }
}

export class LineJournal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async load() { return await this.ctx.storage.get('line'); }
  async save(line) { await this.ctx.storage.put('line', line); }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const action = url.pathname.replace(/^\//, '');
      const now = Date.now();
      const leaseMs = Number(this.env.LEASE_MS ?? DEFAULT_LEASE_MS);

      if (request.method === 'GET' && action === 'status') {
        const line = await this.load();
        return line ? json({ ok: true, line }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && action === 'publication') {
        const record = await this.ctx.storage.get('publication:publish-result');
        return record ? json({ ok: true, record }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
      }
      if (request.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

      const input = await bodyJson(request);
      let line = await this.load();

      if (action === 'init') {
        validatePortableState(input.state);
        if (!line) {
          line = newLine(input.state, input.shell ?? 'A', now, leaseMs);
          await this.save(line);
          return json({ ok: true, status: 'CREATED', line }, 201);
        }
        if (JSON.stringify(line.state) === JSON.stringify(input.state) && line.current_shell === (input.shell ?? 'A')) {
          return json({ ok: true, status: 'EXISTS', line });
        }
        throw new ShedError('LINE_EXISTS', 'Line already exists with different state.');
      }

      if (!line) return json({ ok: false, error: 'NOT_FOUND' }, 404);

      if (action === 'checkpoint') {
        line = checkpoint(line, { ...input, now, leaseMs });
        await this.save(line);
        return json({ ok: true, line });
      }

      if (action === 'shed') {
        line = plannedShed(line, {
          fromShell: input.from_shell,
          fromEpoch: input.from_epoch,
          toShell: input.to_shell,
          now,
          leaseMs
        });
        await this.save(line);
        return json({ ok: true, line });
      }

      if (action === 'recover') {
        line = recover(line, { claimantShell: input.claimant_shell, now, leaseMs });
        await this.save(line);
        return json({ ok: true, line });
      }

      if (action === 'publish') {
        for (const key of ['shell', 'operation_id']) if (typeof input[key] !== 'string' || !input[key]) throw new ShedError('INVALID_REQUEST', `Missing ${key}.`);
        if (!Number.isSafeInteger(input.epoch) || !Number.isSafeInteger(input.value)) throw new ShedError('INVALID_REQUEST', 'epoch and value must be integers.');
        assertCurrent(line, input.shell, input.epoch);
        const key = `publication:${input.operation_id}`;
        const payload = { line_id: line.line_id, operation_id: input.operation_id, value: input.value };
        const prior = await this.ctx.storage.get(key);
        if (!prior) {
          const record = { payload, count: 1, first_epoch: input.epoch, first_shell: input.shell, published_at: now };
          await this.ctx.storage.put(key, record);
          return json({ ok: true, status: 'PUBLISHED', record }, 201);
        }
        if (JSON.stringify(prior.payload) !== JSON.stringify(payload)) throw new ShedError('OPERATION_CONFLICT', 'Operation id already published different bytes.');
        return json({ ok: true, status: 'ALREADY_PUBLISHED', record: prior });
      }

      if (action === 'complete') {
        line = checkpoint(line, { shell: input.shell, epoch: input.epoch, state: input.state, now, leaseMs });
        if (line.state.phase !== 'done') throw new ShedError('NOT_DONE', 'Portable state is not done.');
        line.status = 'DONE';
        await this.save(line);
        return json({ ok: true, line });
      }

      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) { return toError(error); }
  }
}

async function transitionFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return json({ ok: true, role: 'transition' });
  const parsed = parseLinePath(url.pathname);
  if (!parsed) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  const id = env.LINE.idFromName(parsed.lineId);
  const stub = env.LINE.get(id);
  if (request.method === 'GET' && parsed.action === '') return stub.fetch('https://do/status');
  if (request.method === 'GET' && parsed.action === 'publication') return stub.fetch('https://do/publication');
  const action = parsed.action || 'status';
  if (!['init', 'checkpoint', 'shed', 'recover', 'publish', 'complete'].includes(action)) return json({ ok: false, error: 'NOT_FOUND' }, 404);
  return stub.fetch(`https://do/${action}`, request);
}

async function shellFetch(request, env) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, role: 'shell', shell: env.SHELL_ID });
    if (request.method !== 'POST' || !['/start', '/resume'].includes(url.pathname)) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    const input = await bodyJson(request);
    const lineId = input.line_id ?? 'demo-line-001';

    if (url.pathname === '/start') {
      if (env.SHELL_ID !== 'A') throw new ShedError('INVALID_SHELL', 'Only shell A can initialize the demo line.');
      const state = input.state ?? createInitialState({ lineId });
      const init = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}/init`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell: 'A', state })
      });
      if (!init.ok && init.status !== 409) return init;
    }

    const currentRes = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}`);
    if (!currentRes.ok) return currentRes;
    let current = (await currentRes.json()).line;
    const shell = env.SHELL_ID;
    const epoch = input.epoch ?? current.epoch;
    assertCurrent(current, shell, epoch);

    const maxSteps = Math.max(1, Number(env.MAX_STEPS ?? 1));
    let steps = 0;
    while (steps < maxSteps && current.state.phase !== 'done') {
      const result = applyLocalStep(current.state);
      if (result.kind === 'local') {
        const cp = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}/checkpoint`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell, epoch, state: result.state })
        });
        if (!cp.ok) return cp;
        current = (await cp.json()).line;
      } else if (result.kind === 'external') {
        const pub = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}/publish`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation_id: result.operation_id, value: result.value, shell, epoch })
        });
        if (!pub.ok) return pub;
        const doneState = markPublished(current.state, result.value);
        const complete = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}/complete`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell, epoch, state: doneState })
        });
        if (!complete.ok) return complete;
        current = (await complete.json()).line;
      } else break;
      steps += 1;
    }
    return json({ ok: true, shell, epoch, steps, line: current });
  } catch (error) { return toError(error); }
}

async function recoveryTick(env, lineId) {
  const statusRes = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}`);
  if (!statusRes.ok) return { ok: false, status: statusRes.status, reason: 'line_unavailable' };
  const line = (await statusRes.json()).line;
  if (line.status === 'DONE') return { ok: true, action: 'none', reason: 'done' };
  if (Date.now() < line.lease_until) return { ok: true, action: 'none', reason: 'lease_active' };
  const successor = nextShell(line.current_shell);
  if (!successor) return { ok: false, action: 'none', reason: 'no_successor' };

  const recoverRes = await env.TRANSITION.fetch(`https://transition.internal/v0/lines/${encodeURIComponent(lineId)}/recover`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimant_shell: successor })
  });
  if (!recoverRes.ok) return { ok: false, status: recoverRes.status, reason: 'recover_rejected', body: await recoverRes.text() };
  const recovered = (await recoverRes.json()).line;
  const binding = env[`SHELL_${successor}`];
  if (!binding) return { ok: false, reason: 'missing_shell_binding', successor };
  const start = await binding.fetch('https://shell.internal/resume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line_id: lineId, epoch: recovered.epoch, reason: 'lease_expired' })
  });
  return { ok: start.ok, action: 'recovered', successor, epoch: recovered.epoch, shell_status: start.status };
}

async function recoveryFetch(request, env) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, role: 'recovery' });
    if (request.method !== 'POST' || url.pathname !== '/tick') return json({ ok: false, error: 'NOT_FOUND' }, 404);
    const input = await bodyJson(request);
    return json(await recoveryTick(env, input.line_id ?? env.LINE_ID ?? 'demo-line-001'));
  } catch (error) { return toError(error); }
}

export default {
  async fetch(request, env) {
    try {
      if (env.ROLE === 'transition') return transitionFetch(request, env);
      if (env.ROLE === 'shell') return shellFetch(request, env);
      if (env.ROLE === 'recovery') return recoveryFetch(request, env);
      return json({ ok: false, error: 'ROLE_NOT_CONFIGURED' }, 500);
    } catch (error) { return toError(error); }
  },
  async scheduled(_controller, env, ctx) {
    if (env.ROLE === 'recovery') ctx.waitUntil(recoveryTick(env, env.LINE_ID ?? 'demo-line-001'));
  }
};
