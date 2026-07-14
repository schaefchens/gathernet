# ADR 0001: mls-rs for production end-to-end encryption

## Status

Accepted.

## Context

Gathernet requires end-to-end encrypted messaging for friend chat, app/game
rooms, and persistent communities. Every conversation is cryptographically a
group, because each user may have multiple devices. The protocol must support:

- Multi-device group membership with efficient add/remove (epoch changes).
- Forward secrecy and post-compromise security.
- A server that only ever relays ciphertext and orders commits.
- Browser clients (the platform is web-first; clients are PWAs).

MLS (Messaging Layer Security, RFC 9420) is the IETF standard designed exactly
for this shape: continuous group key agreement with epochs, Welcome messages,
and external commits.

## Decision

Production E2EE uses **MLS via the `mls-rs` crate** (AWS Labs' RFC 9420
implementation), compiled to WebAssembly for browser clients.

Milestone 1 specifics:

- Sync build of `mls-rs` with the `mls-rs-crypto-rustcrypto` provider
  (pure Rust, compiles cleanly to `wasm32-unknown-unknown`).
- Ciphersuite 3: `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`.
  ChaCha20-Poly1305 outperforms software AES in WASM and keeps the whole
  system on one curve family (X25519/Ed25519).
- Group state persistence via in-memory storage plus explicit serialized
  snapshots, encrypted client-side and stored in IndexedDB. Snapshots are
  persisted before ciphertext is released to the network (crash consistency —
  restoring an older snapshot after encrypting would reuse ratchet keys).
- New-device restore joins existing groups via **external commit**
  (`Client::commit_external`) using server-stored GroupInfo, so restore never
  depends on another device being online.
- The TypeScript server acts as the MLS Delivery Service: key package storage
  and claim, Welcome delivery, per-group commit sequencing (optimistic epoch
  check, 409 on stale), ciphertext mailbox until per-device ack.

## Alternatives considered

- **libsignal / Signal protocol**: pairwise sessions with sender keys bolted on
  for groups; multi-device and large-group membership changes are much more
  expensive than MLS epochs, and there is no standard external-join mechanism.
- **OpenMLS**: viable Rust MLS implementation, but mls-rs has broader
  ciphersuite/provider modularity, explicit wasm32 CI coverage, and
  `last_resort_key_package_ext` / external-commit APIs we need.
- **ts-mls (pure TypeScript)**: no Rust/WASM toolchain needed, but younger,
  less reviewed, and a JS crypto stack is harder to audit and harden than a
  single WASM module.

## Consequences

- The repo contains a Rust workspace (`crates/mls-wasm`) and a WASM build step
  in the pipeline; contributors need `rustup` + `wasm-pack` (or use CI
  artifacts).
- `mls-rs` and its RustCrypto provider are not yet third-party audited: exact
  versions are pinned, advisories monitored, and an external audit is budgeted
  before public launch. The standard ciphersuite keeps providers swappable.
- All client-side cryptography (BIP39, HKDF, Ed25519, Argon2id,
  XChaCha20-Poly1305, MLS) lives in the one WASM module — no split-brain
  between WebCrypto and WASM implementations.
