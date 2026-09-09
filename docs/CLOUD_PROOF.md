# SHED v0.1 — cloud proof record

Date: 2026-09-09

This file records the already completed Cloudflare experiment. It is evidence for the tested implementation boundary, not a claim of universal agent independence.

## Confirmed

- Full cloud A → B → C experiment: **PASS**.
- C completed the unfinished task.
- Final deterministic result: **377**.
- The logical external publication occurred **once**.
- Returned old A and B were rejected with **`STALE_EPOCH`**.
- All five test Workers were restored after the experiment.
- Local release suite: **17/17 tests passed**.

## What this proves

Within the tested Cloudflare boundary, an execution line can move from A to B, recover from loss of B onto C, preserve unfinished work, prevent stale predecessors from acting as the current line, and keep a stable logical operation id from becoming a duplicate publication after migration.

## What this does not prove

The current v0.1 journal remains a required trust/state/recovery point and is hosted on Cloudflare. Therefore this experiment does **not** prove independence from Cloudflare or from every infrastructure operator.

The goal of v0.1 is narrower: prove repeatable shell replacement and stale-predecessor rejection before adding payments, discovery, provider markets, or broader portability.
