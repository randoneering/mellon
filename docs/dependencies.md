# Dependency review

## Assessment status

The operator attempted Socket assessment of the candidate dependencies. Socket returned `401 Unauthorized`, including on retry after the operator reported reconnection. No successful security or package-quality assessment is available. The operator explicitly waived this availability blocker so implementation could continue. This waiver is not a passing scan and does not establish that the dependencies are safe. Any reported low score still requires an operator decision. Assessment status remains **unknown**.

## Runtime and build inventory

The scorer uses the locked `wink-nlp` 2.4.0 package and the `wink-eng-lite-web-model` 1.8.1 package. The build uses `esbuild` 0.28.2 and `@esbuild/linux-x64` 0.28.2. `markdown-it` 15.0.3 prepares CommonMark source maps. Build/test release validation uses `yaml` 2.9.1. Versions are exact in the root manifest and lockfile.

`markdown-it` bundles `argparse` 3.0.4 (PSF-2.0), `entities` 8.1.0 (BSD-2-Clause), `linkify-it` 6.1.0 (MIT), `mdurl` 2.1.0 (MIT), `punycode.js` 2.3.1 (MIT), and `uc.micro` 3.0.0 (MIT). `dist/THIRD_PARTY_NOTICES.txt` carries notices for these transitive packages as well as the detector dependencies.

The parser token stream supplies source line maps; preparation consumes fence and blockquote spans. Markdown is not rendered to HTML, and no plugins, highlighting, link fetching, or code execution are enabled. Parser, Action, and scorer dependencies share a Node process and the Action credential trust boundary. They are not sandboxed from the token.

The detector's pinned upstream source, model assets, checksum records, and notices are vendored distribution inputs rather than npm dependencies. Model provenance is separately pinned because the upstream source repository does not contain that published artifact. See [detector details](scorer.md).

## Build and parity checks

From the repository root with Node 24:

```sh
npm ci --ignore-scripts
npm run verify:assets
npm run test:build
npm test
npm run test:parity
npm run build
npm run validate:release
```

The deterministic build produces `dist/index.mjs`, `dist/scorer.mjs`, `dist/detector/` provenance and vendored assets, `dist/build-meta.json`, and `dist/THIRD_PARTY_NOTICES.txt`. Generated files are included in the reviewed Action release. The JavaScript Action bundles npm packages and resolves scorer assets relative to its own installation, never a consumer workspace. Runtime does not install packages or download inference assets.

`npm run validate:release` parses metadata and the consumer workflow template, checks supported opening-event filters, least permissions, per-item serialization, timeout, placeholder SHA, and required release files. The built Action test runs from an isolated copy without `node_modules`. Parity tests compare all ten detector reference cases within absolute tolerance `1e-9` and asset integrity checks reject altered model bytes.

No Go CLI, Goldmark parser, subprocess protocol, or container is part of this JavaScript Action runtime. The Action requires a maintained Node 24 Linux runner and rejects UID zero.

## Upstream snapshot and provenance

The upstream source snapshot is pinned to revision `9d3abed60e628951c7b0d2cd1e1c69eddb23eb97`. The published model is independently pinned to SHA-256 `228087029eceee8a1c6cd57f29ec484a0141c639f8ed139fd506ef27eaa98825` because it is absent from the source repository. Vendored notices remain alongside detector assets and are copied into the release notices file.

## Continuing review

Run locked tests, parity, asset, and build checks when changing dependencies. Reassess dependencies when Socket or another approved package-assessment service is available. A lockfile and successful local tests are not a security assessment.
