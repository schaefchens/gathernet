//! Pure-Rust internals wrapped by the wasm-bindgen exports in `crate::wasm`.
//! Everything here compiles and runs natively so it can be unit tested with
//! plain `cargo test`.

pub mod cert;
pub mod crypto;
pub mod device;
pub mod error;
pub mod identity;
pub mod storage;
