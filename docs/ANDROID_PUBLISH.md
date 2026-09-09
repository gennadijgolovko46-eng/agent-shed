# Manual GitHub publication from Android

Repository: `gennadijgolovko46-eng/agent-shed`

The repository currently contains only the old `README.md`. Publish the v0.1 bundle to branch `main`.

## Safest method on Android

Use GitHub in the browser (Desktop site mode if the mobile page hides file controls).

For each path below:

1. Open the repository.
2. Tap **Add file** → **Create new file**.
3. In the filename box, type the complete path exactly. GitHub creates directories when the name contains `/`.
4. Paste the complete contents of that file.
5. Tap **Commit changes**.
6. Commit directly to `main` for this initial publication.

For `README.md`, open the existing file, tap the pencil/Edit button, replace its entire contents, then commit.

Publish in this order:

1. `README.md` (replace existing)
2. `package.json`
3. `.gitignore`
4. `LICENSE`
5. `src/core.mjs`
6. `src/worker.mjs`
7. `test/core.test.mjs`
8. `wrangler.jsonc`
9. `docs/CLOUD_PROOF.md`
10. `docs/THREAT_MODEL.md`
11. `docs/ANDROID_PUBLISH.md`
12. `.github/workflows/ci.yml`

The workflow is deliberately last. As soon as `.github/workflows/ci.yml` is committed, GitHub Actions should run `npm test` on the complete repository rather than on a half-published tree.

## Expected CI result

The test job must report:

- tests: 17
- pass: 17
- fail: 0

Do not treat publication as complete until the Actions run is green.

## Important release note

The active ChatGPT runtime could verify that GitHub currently contains only the original README, but it could not recover the exact byte-for-byte source bundle that produced the earlier cloud PASS. This manual bundle is a clean reconstruction of the already proven v0.1 mechanism and passes the same 17-property local suite. Do not describe its source hash as identical to the previously deployed Cloudflare source unless that original deployment source is later recovered and compared.
