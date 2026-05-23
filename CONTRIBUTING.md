# Contributing to YusafCut

YusafCut is built around a single, deliberate architectural decision: **the EDL
(Edit Decision List) is the source of truth**. Every contribution should
preserve the invariants documented in
[`src/lib/edl.ts`](src/lib/edl.ts) and
[`docs/architecture.md`](docs/architecture.md).

## Development setup

You will need:

- **Node ≥ 20** (use `nvm use` to match `.nvmrc`)
- **Rust stable** with `rustup`
- **Xcode Command Line Tools** (`xcode-select --install`)
- **An Apple Silicon Mac** (Intel is out of scope per spec section 2)

```bash
npm install
# optional: populate sidecar binaries for actual transcription/export
./src-tauri/binaries/fetch.sh
npm run tauri:dev
```

## Branching + PRs

- `main` is always shippable.
- Open work happens on topic branches: `phase-2/whisper-progress`,
  `fix/edl-padding-edge-case`, etc.
- Every PR runs the CI workflow: lint, typecheck, vitest, rust fmt, clippy,
  cargo test, and a build smoke test. Get them green before requesting review.

## Code style

- TypeScript: `prettier` enforces formatting. Run `npm run format`.
- Rust: `cargo fmt --all`. Clippy warnings are treated as errors in CI.
- Avoid one-letter variable names except for indices.
- Prefer pure functions in `src/lib/`; side effects live in components and
  stores.

## Testing

- **Pure logic** belongs in `src/lib/` and gets a Vitest test next to it.
- **EDL operations** are held to a 100% coverage target — see `tests/edl.test.ts`
  for the existing suite. Add tests when you add operations.
- **Rust** code uses standard `#[cfg(test)]` modules. Pure parsers (FFprobe
  JSON, Whisper JSON) must be testable without spawning the binary.
- **Integration tests** are deliberately minimal in v1. Manual checklist lives
  at `docs/manual-test.md`.

## Don't deviate from the architecture without discussion

The spec document at the repo root is binding. If you think a phase should be
rearranged, or a tech choice should change, open a draft issue first. Push
back on suggestions (including AI suggestions) that drift without
justification.

## Security disclosures

See `SECURITY.md`.
