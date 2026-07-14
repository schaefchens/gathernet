# mls-wasm

Rust → WebAssembly MLS module for Gathernet E2EE chat, built on
[mls-rs](https://docs.rs/mls-rs) 0.55 with the RustCrypto provider and MLS
ciphersuite 3 (X25519 / ChaCha20-Poly1305 / Ed25519 / SHA-256).

## Build

```sh
# From the repo root; output goes to packages/mls-client/wasm
pnpm wasm:build

# Native tests (pure-Rust core, no wasm required)
cd crates && cargo test
```

The wasm-bindgen exports in `src/wasm.rs` are thin wrappers over the pure-Rust
internals in `src/core/`, which is what `cargo test` exercises.

## Snapshot crash-consistency rule

Every mutating group operation (`create_group`, `add_members`,
`remove_members`, `join_from_welcome`, `external_join`, `encrypt`,
`process_incoming`) returns a `snapshot`: the serialized state of that group
(current state plus up to 3 retained prior epochs) taken AFTER the operation
was applied.

**Persist the snapshot BEFORE releasing any ciphertext or commit produced by
the same call.** If the app crashes after sending a ciphertext but before
persisting the snapshot, reloading the older snapshot and encrypting again
reuses ratchet positions; receivers will reject the replayed generations and
the sending device desynchronizes. Persist-then-send makes a crash merely drop
an unsent message.

Key packages follow the same rule: `generate_key_package` returns the private
entry (`privateState`, keyed by `ref`); persist it until the corresponding
Welcome has been processed, and restore it with `import_key_package_private`
after a restart.
