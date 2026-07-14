//! Gathernet MLS WebAssembly module.
//!
//! `core` contains pure-Rust internals (natively testable); `wasm` contains the
//! wasm-bindgen exports that wrap them.

pub mod core;

#[cfg(target_arch = "wasm32")]
mod wasm;
