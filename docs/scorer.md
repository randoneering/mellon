# JavaScript scorer

Mellon runs `aicomment` inference in-process in the Node 24 Action runtime. The import-safe source scorer is `detector/scorer.mjs`; `detector/adapter.mjs` preserves the legacy stdin/stdout test adapter and re-exports `scoreRequest`. The release entrypoint seam is `dist/scorer.mjs`, which later Action code can import directly. It does not load the adapter or invoke its stdin main.

The scorer returns `outcome`, `robot_score` when classification is nonempty, `detector_revision`, `model_sha256`, and `input_sha256`. The latter hashes the exact UTF-8 prose passed to upstream classification, including upstream boundary markers. Every inference call validates the detector manifest and all 14 recorded asset SHA-256 values before loading upstream modules. Classification preserves upstream preprocessing, model inference, 50/50 human/robot prior, and class collapse.

## Sources and notices

`detector/provenance.json` records every packaged upstream asset and its SHA-256. Inference code comes from Git revision `9d3abed60e628951c7b0d2cd1e1c69eddb23eb97` at https://git.sr.ht/~kqr/aicomment. The repository excludes its trained model and generated language registry. With operator approval, Mellon snapshots those published assets separately from https://xkqr.org/aicomment/ and pins their hashes. The model SHA-256 is `228087029eceee8a1c6cd57f29ec484a0141c639f8ed139fd506ef27eaa98825`. This hash identifies independently published model bytes, not a model committed in the Git revision.

Keep the upstream copyright/permission notice in `detector/vendor/aicomment/LICENSE`. The wink packages declare MIT licenses; preserve their package notices when distributing the runtime. The project retains its existing AGPL-3.0 license. See [dependency review](dependencies.md) for the unverified Socket assessment and operator waiver.

## Build and verify

From the repository root, use Node 24 and run:

```sh
npm ci --ignore-scripts
npm run verify:assets
npm test
npm run test:parity
npm run build
```

The exact runtime versions are `wink-nlp` 2.4.0 and `wink-eng-lite-web-model` 1.8.1. The build uses development-only `esbuild` 0.28.2 and its platform binary, locked in the root `package-lock.json`. esbuild targets `node24`, platform `node`, and ESM output. It bundles npm inference dependencies while leaving Node built-ins external. The generated artifact and build metadata are written to `dist/`; `dist/` is ignored because it is generated and must not be edited by hand.

`detector/tests/bundle.test.mjs` copies only the built scorer, provenance, and vendor assets into a temporary release location without any `node_modules` in its ancestry. It verifies that all ten independent upstream fixtures retain their exact input identities and scores within `1e-9`; its temporary dependency installation is scoped inside that release copy. The test also mutates a copied model to confirm runtime checksum rejection. This demonstrates local inference without package/model/network access at runtime. The scorer uses an explicit bundle root for these tests; the later Action must pass its trusted installation asset root rather than rely on the consumer workspace.

## Updating upstream inputs

1. Select an immutable source revision and inventory its relative imports.
2. Copy the required runtime modules and notices without rewriting vendored code.
3. Fetch published-only model/registry assets deliberately, record their actual sources, and pin their hashes separately.
4. Update provenance, exact npm versions, and the lock file.
5. Run asset verification, source tests, and bundled parity before adoption.

Do not fetch a model, script, or npm package during classification. Changes to model bytes or preprocessing can change moderation outcomes even when the policy cutoff stays `0.80`.

## Limitations

The detector was trained on code comments; its probabilities are **not validated for issue/PR prose**. The `0.80` cutoff is a repository policy threshold, not a calibrated authorship probability. A score cannot establish authorship, an AI-written fraction, contribution quality, or the contributor's understanding. AI-assisted code is welcome; contributors should understand their work and describe it in their own words. Short input and retained repository template text can influence results.
