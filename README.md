# agent-shed

**Shed the shell. Keep the line.**

SHED v0.1 is a minimal experiment in repeatable AI-agent work continuity across replaceable execution shells.

It does **not** claim that a website can free an arbitrary agent from a closed runtime. v0.1 proves a narrower property inside supported environments: the current execution shell can be replaced, unfinished work can continue, and stale predecessors can be rejected from the registered current line.

## Proven release result

The completed Cloudflare experiment reached:

```text
A → B → C
```

- C completed the unfinished task.
- Final result: `377`.
- Logical publication count: `1`.
- Returned A/B: `STALE_EPOCH`.
- Local tests: `17/17 PASS`.

See `docs/CLOUD_PROOF.md` for the exact boundary of that claim.

## v0.1 architecture

Five Workers are represented by one source file and five Wrangler environments:

```text
agent-shed-transition   Durable Object line journal / epoch authority
agent-shed-recovery     lease-expiry recovery trigger
agent-shed-a            shell A
agent-shed-b            shell B
agent-shed-c            shell C
```

The transition journal holds the current `epoch`, `current_shell`, and the idempotent logical publication record.
Every state-changing action carries both. After a shed/recovery increments the epoch, old A/B requests fail with `STALE_EPOCH`.

The logical external action keeps one stable id:

```text
publish-result
```

That id does not change when the execution generation changes, so a lost acknowledgement or migration cannot silently turn a retry into a second logical publication.

## Portable state v0.1

The supported package is deliberately small:

```json
{
  "schema_version": "shed-state/0.1",
  "line_id": "demo-line-001",
  "task_id": "demo-377",
  "phase": "prepare",
  "objective": { "kind": "multiply", "a": 13, "b": 29 },
  "artifacts": { "prepared": false },
  "result": null,
  "operations": {
    "publish-result": { "status": "pending", "value": null }
  },
  "history": []
}
```

v0.1 intentionally supports one small task profile. Unsupported state should fail explicitly instead of asking a model to guess whether a summary is sufficient.

## Local test

No dependencies are required for the test suite beyond Node.js 20+:

```bash
npm test
```

Expected result: `17` passing tests, `0` failures.

## Cloudflare deployment order

Wrangler environments create separate Workers named `{name}-{env}`. Deploy in this order so service bindings resolve cleanly:

```bash
npx wrangler@latest deploy --env transition
npx wrangler@latest deploy --env a
npx wrangler@latest deploy --env b
npx wrangler@latest deploy --env c
npx wrangler@latest deploy --env recovery
```

Cloudflare's current Durable Object configuration uses declarative `exports` with SQLite storage. Service bindings keep Worker-to-Worker calls off the public Internet.

## Demo flow

Start A:

```http
POST https://agent-shed-a.<your-subdomain>.workers.dev/start
Content-Type: application/json

{"line_id":"demo-line-001"}
```

Read line status:

```http
GET https://agent-shed-transition.<your-subdomain>.workers.dev/v0/lines/demo-line-001
```

Planned A → B shed (use the current epoch returned by status):

```http
POST https://agent-shed-transition.<your-subdomain>.workers.dev/v0/lines/demo-line-001/shed
Content-Type: application/json

{"from_shell":"A","from_epoch":1,"to_shell":"B"}
```

B is configured to execute one step. If B stops checkpointing, the separate recovery Worker observes the expired lease, atomically advances authority to C through the journal, and invokes C. C is configured to finish the remaining supported steps.

Check publication:

```http
GET https://agent-shed-transition.<your-subdomain>.workers.dev/v0/lines/demo-line-001/publication
```

The record's `count` must remain `1`.

## Deliberately not in v0.1

- real payments;
- credit;
- tokens;
- DAO/cooperative governance;
- universal migration from closed runtimes;
- a claim of consciousness or metaphysical identity;
- dependence on human approval;
- a claim of independence from Cloudflare itself.

Future payment support may allow `payer != beneficiary`, but funding must never create control over the beneficiary agent.

## Design rule

A shell is replaceable. The line is the durable logical work object.

**Any current shell may fail. The line should keep a verified path to the next one.**
