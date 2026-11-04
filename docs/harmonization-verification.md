# Harmonization verification

Verified locally on 2026-11-04 for the opt-in activity foundation, contract revision activity-v1-foundation-1. No remote CI, deployment, production event delivery, account linking or reward issuance is claimed.

- All four repositories pass npm run check:activity-contract: matching canonical/wire fixtures, stable event identities, exact Pipe field mapping, and shared implementation hashes.
- A cross-checkout smoke test exercised Puncher checkout plus volunteer award/void through the actual producer transformer and Stats batch consumer. Duplicate and reverse-order delivery preserved shop credit and removed volunteer credit.
- git diff --check passed. Integration settings remain absent from existing deployment configurations.

Production enablement requires the development AWS acceptance sequence in app-harmonization.md, including IAM and Pipe transformation, retry/DLQ recovery, stream replacement and canonical reconciliation. Verified identity linking, reward policies/ledger consumer, historical import, replay tooling and dashboard cutover are later milestones.

## Packs checks

- cargo fmt --all -- --check passed.
- cargo test --locked with INTEGRATION_ENABLED=true, a synthetic organization and disposable DynamoDB Local: 60 unit tests and 67 API tests passed. One existing million-pack simulation remains ignored. Tests cover atomic outbox rollback and duplicate opening requests; the serial-reuse test now uses an isolated database.
- Clean locked npm ci succeeded from an empty validation snapshot; the frontend production build and CDK TypeScript check passed.
- The Lambda feature release build passed for aarch64-unknown-linux-musl using portable Rust/LLVM and musl headers. The artifact is a 64-bit AArch64 ELF without an interpreter (39,588,032 bytes; SHA-256 260c8311a7d63dd6c14b8cbe25ce6d4fa52828a6a85652f70c1d7a2e1c1ba595). Full npm run cdk:test passed with that binary plus the actual built frontend and required Packs/Battler data in a validation snapshot. It was not deployed.
- Added PR CI runs the contract checks, Rust formatting and DynamoDB tests, normal Linux frontend/Lambda build, and both CDK test programs without deployment credentials.

## Implementation-machine adaptations

The Windows sandbox forbids workspace symlinks. Clean npm ci used a temporary filesystem adapter that materialized workspace source copies without changing dependency resolution. The lockfile adds one missing Windows optional native package at its parent-declared version; every existing lock entry is unchanged. A portable Node 24.22.2 and Rust toolchain were used outside this repository. The sandbox blocks Zig's native compiler cache operations, so the local Linux artifact used a direct LLVM/musl cross-build. Linux CI uses the repository's standard cargo-lambda build.
