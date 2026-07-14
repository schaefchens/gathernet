//! Device certificates and credentials.
//!
//! A device certificate is a deterministic CBOR array:
//! `[version(1), bytes(account_pk), bytes(device_pk), bytes(device_id), str(name), u64(created_at)]`
//!
//! A credential is `cert_bytes || 64-byte Ed25519 signature`, where the signature
//! is `Ed25519(IK, "gathernet-device-cert-v1" || cert_bytes)`.

use super::crypto::{device_id_bytes_from_public, verify_device_cert_sig};
use super::error::CoreError;

pub const CERT_VERSION: u8 = 1;
const SIG_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCert {
    pub version: u8,
    pub account_pk: Vec<u8>,
    pub device_pk: Vec<u8>,
    pub device_id: [u8; 16],
    pub name: String,
    pub created_at: u64,
}

impl DeviceCert {
    pub fn device_id_hex(&self) -> String {
        hex::encode(self.device_id)
    }

    pub fn account_id(&self) -> String {
        bs58::encode(&self.account_pk).into_string()
    }
}

/// Deterministic CBOR encoding of a device certificate.
pub fn encode_device_cert(
    account_pk: &[u8],
    device_pk: &[u8],
    name: &str,
    created_at_secs: u64,
) -> Result<Vec<u8>, CoreError> {
    if account_pk.len() != 32 {
        return Err(CoreError::Cert("account_pk must be 32 bytes".into()));
    }
    if device_pk.len() != 32 {
        return Err(CoreError::Cert("device_pk must be 32 bytes".into()));
    }
    let device_id = device_id_bytes_from_public(device_pk);
    let mut buf = Vec::new();
    let mut enc = minicbor::Encoder::new(&mut buf);
    enc.array(6)
        .and_then(|e| e.u8(CERT_VERSION))
        .and_then(|e| e.bytes(account_pk))
        .and_then(|e| e.bytes(device_pk))
        .and_then(|e| e.bytes(&device_id))
        .and_then(|e| e.str(name))
        .and_then(|e| e.u64(created_at_secs))
        .map_err(|e| CoreError::Cbor(e.to_string()))?;
    Ok(buf)
}

/// Decode a device certificate (no signature verification).
pub fn decode_device_cert(bytes: &[u8]) -> Result<DeviceCert, CoreError> {
    let mut dec = minicbor::Decoder::new(bytes);
    let len = dec.array()?;
    if len != Some(6) {
        return Err(CoreError::Cert("expected 6-element CBOR array".into()));
    }
    let version = dec.u8()?;
    if version != CERT_VERSION {
        return Err(CoreError::Cert(format!(
            "unsupported cert version {version}"
        )));
    }
    let account_pk = dec.bytes()?.to_vec();
    let device_pk = dec.bytes()?.to_vec();
    let device_id_slice = dec.bytes()?;
    let name = dec.str()?.to_string();
    let created_at = dec.u64()?;

    if account_pk.len() != 32 {
        return Err(CoreError::Cert("account_pk must be 32 bytes".into()));
    }
    if device_pk.len() != 32 {
        return Err(CoreError::Cert("device_pk must be 32 bytes".into()));
    }
    let device_id: [u8; 16] = device_id_slice
        .try_into()
        .map_err(|_| CoreError::Cert("device_id must be 16 bytes".into()))?;
    if device_id != device_id_bytes_from_public(&device_pk) {
        return Err(CoreError::Cert(
            "device_id does not match SHA-256(device_pk)".into(),
        ));
    }
    Ok(DeviceCert {
        version,
        account_pk,
        device_pk,
        device_id,
        name,
        created_at,
    })
}

/// Build credential bytes: cert_bytes || 64-byte signature.
pub fn make_credential(cert_bytes: &[u8], cert_sig: &[u8]) -> Result<Vec<u8>, CoreError> {
    if cert_sig.len() != SIG_LEN {
        return Err(CoreError::Credential(format!(
            "signature must be {SIG_LEN} bytes, got {}",
            cert_sig.len()
        )));
    }
    // Validate the cert structure eagerly so malformed credentials fail early.
    decode_device_cert(cert_bytes)?;
    let mut out = Vec::with_capacity(cert_bytes.len() + SIG_LEN);
    out.extend_from_slice(cert_bytes);
    out.extend_from_slice(cert_sig);
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCredential {
    pub cert: DeviceCert,
    pub sig: [u8; 64],
}

/// Split, decode and VERIFY a credential (cert_bytes || sig).
///
/// The signature is checked against the account public key embedded in the cert.
pub fn parse_and_verify_credential(bytes: &[u8]) -> Result<VerifiedCredential, CoreError> {
    if bytes.len() <= SIG_LEN {
        return Err(CoreError::Credential("credential too short".into()));
    }
    let (cert_bytes, sig_bytes) = bytes.split_at(bytes.len() - SIG_LEN);
    let cert = decode_device_cert(cert_bytes)?;
    let sig: [u8; 64] = sig_bytes.try_into().expect("split guarantees 64 bytes");
    if !verify_device_cert_sig(&cert.account_pk, cert_bytes, &sig) {
        return Err(CoreError::CredentialSignature);
    }
    Ok(VerifiedCredential { cert, sig })
}
