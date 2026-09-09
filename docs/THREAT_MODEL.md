# SHED v0.1 — threat model

## Protected properties in v0.1

1. A stale shell cannot checkpoint or publish as the current epoch.
2. A stable external `operation_id` is not turned into a new operation by a shell change.
3. Retrying an identical publication is idempotent.
4. Reusing the same operation id for different bytes fails closed.
5. A missing/expired current shell may be replaced only by the configured successor.
6. Portable task state is explicit and versioned.

## Known limits

- The journal is still a trusted availability/state component.
- Cloudflare account/provider failure is outside the demonstrated recovery boundary.
- v0.1 supports one deliberately small task/state profile, not arbitrary hidden model state.
- Secrets already exposed to an old shell cannot be made secret retroactively.
- Exactly-once effects on an arbitrary third-party service require that service to support an idempotency key or equivalent reconciliation. The demo publisher supplies that property explicitly.
- v0.1 has no payments, credit, token, DAO, cooperative, or human approval system.

## Funding rule reserved for later versions

A future payer may pay for another line's shed. Payment must not grant the payer control over the beneficiary line, its keys, goals, or future sheds.
