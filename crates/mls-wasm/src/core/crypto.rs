//! Pure crypto helpers: BIP39 identity derivation, device keys, Argon2id,
//! XChaCha20-Poly1305 sealing and base58 account ids.

use bip39::Mnemonic;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use super::error::CoreError;

/// HKDF info string for deriving the account (identity) Ed25519 key from a BIP39 seed.
pub const IDENTITY_HKDF_INFO: &[u8] = b"gathernet/v1/identity/ed25519";
/// HKDF salt used for all gathernet key derivations.
pub const IDENTITY_HKDF_SALT: &[u8] = b"gathernet";
/// Domain separation prefix for device certificate signatures.
pub const DEVICE_CERT_SIG_DOMAIN: &[u8] = b"gathernet-device-cert-v1";
/// HKDF salt for the storage-root derivation (distinct from the identity salt).
pub const STORAGE_HKDF_SALT: &[u8] = b"gathernet-storage-v1";
/// HKDF info string for the storage-root derivation.
pub const STORAGE_HKDF_INFO: &[u8] = b"gathernet/v1/storage/v1";

pub fn random_bytes(len: usize) -> Result<Vec<u8>, CoreError> {
    let mut out = vec![0u8; len];
    getrandom02::getrandom(&mut out).map_err(|e| CoreError::Rng(e.to_string()))?;
    Ok(out)
}

/// Generate a fresh BIP39 English 12-word mnemonic (128 bits of entropy).
pub fn generate_mnemonic() -> Result<String, CoreError> {
    let entropy = Zeroizing::new(random_bytes(16)?);
    let mnemonic =
        Mnemonic::from_entropy(&entropy).map_err(|e| CoreError::Mnemonic(e.to_string()))?;
    Ok(mnemonic.to_string())
}

/// Check whether `phrase` is a valid BIP39 English mnemonic.
pub fn validate_mnemonic(phrase: &str) -> bool {
    Mnemonic::parse(phrase).is_ok()
}

/// Derive the 32-byte storage-root key from a BIP39 mnemonic:
/// BIP39 seed (empty passphrase) -> HKDF-SHA256(seed,
/// salt="gathernet-storage-v1", info="gathernet/v1/storage/v1").
/// Domain-separated from the identity derivation (different salt AND info).
pub fn derive_storage_root(phrase: &str) -> Result<[u8; 32], CoreError> {
    let mnemonic = Mnemonic::parse(phrase).map_err(|e| CoreError::Mnemonic(e.to_string()))?;
    let mut seed = mnemonic.to_seed("");
    let hk = Hkdf::<Sha256>::new(Some(STORAGE_HKDF_SALT), &seed);
    let mut okm = [0u8; 32];
    let expanded = hk
        .expand(STORAGE_HKDF_INFO, &mut okm)
        .map_err(|e| CoreError::Key(e.to_string()));
    seed.zeroize();
    expanded?;
    Ok(okm)
}

/// Account identity keypair, deterministically derived from a BIP39 mnemonic.
pub struct IdentityKeypair {
    signing_key: SigningKey,
}

impl IdentityKeypair {
    /// Derive the identity key: BIP39 seed (empty passphrase) ->
    /// HKDF-SHA256(seed, salt="gathernet", info="gathernet/v1/identity/ed25519") -> 32B Ed25519 seed.
    pub fn from_mnemonic(phrase: &str) -> Result<Self, CoreError> {
        let mnemonic = Mnemonic::parse(phrase).map_err(|e| CoreError::Mnemonic(e.to_string()))?;
        let mut seed = mnemonic.to_seed("");
        let hk = Hkdf::<Sha256>::new(Some(IDENTITY_HKDF_SALT), &seed);
        let mut okm = Zeroizing::new([0u8; 32]);
        hk.expand(IDENTITY_HKDF_INFO, okm.as_mut())
            .map_err(|e| CoreError::Key(e.to_string()))?;
        seed.zeroize();
        Ok(Self {
            signing_key: SigningKey::from_bytes(&okm),
        })
    }

    /// 32-byte raw Ed25519 public key.
    pub fn public_key(&self) -> Vec<u8> {
        self.signing_key.verifying_key().to_bytes().to_vec()
    }

    /// 64-byte Ed25519 signature over `msg`.
    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.signing_key.sign(msg).to_bytes().to_vec()
    }

    /// Sign a device certificate with domain separation:
    /// Ed25519(IK, "gathernet-device-cert-v1" || cert_bytes).
    pub fn sign_device_cert(&self, cert_bytes: &[u8]) -> Vec<u8> {
        let mut msg = Vec::with_capacity(DEVICE_CERT_SIG_DOMAIN.len() + cert_bytes.len());
        msg.extend_from_slice(DEVICE_CERT_SIG_DOMAIN);
        msg.extend_from_slice(cert_bytes);
        self.sign(&msg)
    }

    /// base58btc encoding of the public key.
    pub fn account_id(&self) -> String {
        bs58::encode(self.signing_key.verifying_key().to_bytes()).into_string()
    }
}

// ed25519_dalek::SigningKey zeroizes on drop (zeroize feature), so IdentityKeypair
// does not need a manual Drop impl; documented here for clarity.

/// Per-device Ed25519 keypair.
pub struct DeviceKeypair {
    seed: Zeroizing<[u8; 32]>,
    signing_key: SigningKey,
}

impl DeviceKeypair {
    pub fn generate() -> Result<Self, CoreError> {
        let bytes = Zeroizing::new(random_bytes(32)?);
        Self::from_secret(&bytes)
    }

    pub fn from_secret(bytes: &[u8]) -> Result<Self, CoreError> {
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| CoreError::Key("device secret must be 32 bytes".into()))?;
        let signing_key = SigningKey::from_bytes(&seed);
        Ok(Self {
            seed: Zeroizing::new(seed),
            signing_key,
        })
    }

    /// 32-byte Ed25519 seed.
    pub fn secret(&self) -> Vec<u8> {
        self.seed.to_vec()
    }

    /// 32-byte raw Ed25519 public key.
    pub fn public_key(&self) -> Vec<u8> {
        self.signing_key.verifying_key().to_bytes().to_vec()
    }

    /// Hex of the first 16 bytes of SHA-256(public key).
    pub fn device_id(&self) -> String {
        device_id_from_public(&self.signing_key.verifying_key().to_bytes())
    }
}

/// Device id derivation shared with certificates: hex(first16(SHA-256(device_pk))).
pub fn device_id_bytes_from_public(public: &[u8]) -> [u8; 16] {
    let digest = Sha256::digest(public);
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

pub fn device_id_from_public(public: &[u8]) -> String {
    hex::encode(device_id_bytes_from_public(public))
}

pub fn ed25519_sign(secret_seed: &[u8], msg: &[u8]) -> Result<Vec<u8>, CoreError> {
    let seed: [u8; 32] = secret_seed
        .try_into()
        .map_err(|_| CoreError::Key("ed25519 secret seed must be 32 bytes".into()))?;
    let key = SigningKey::from_bytes(&seed);
    Ok(key.sign(msg).to_bytes().to_vec())
}

pub fn ed25519_verify(public: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let Ok(pk_bytes): Result<[u8; 32], _> = public.try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_bytes) else {
        return false;
    };
    let Ok(sig_bytes): Result<[u8; 64], _> = sig.try_into() else {
        return false;
    };
    vk.verify(msg, &ed25519_dalek::Signature::from_bytes(&sig_bytes))
        .is_ok()
}

/// Verify a domain-separated device cert signature.
pub fn verify_device_cert_sig(account_pk: &[u8], cert_bytes: &[u8], sig: &[u8]) -> bool {
    let mut msg = Vec::with_capacity(DEVICE_CERT_SIG_DOMAIN.len() + cert_bytes.len());
    msg.extend_from_slice(DEVICE_CERT_SIG_DOMAIN);
    msg.extend_from_slice(cert_bytes);
    ed25519_verify(account_pk, &msg, sig)
}

/// Argon2id with named profiles. Output is always 32 bytes.
/// - "default": m=65536 KiB, t=3, p=1
/// - "light":   m=19456 KiB, t=2, p=1
pub fn argon2id_hash(password: &str, salt: &[u8], profile: &str) -> Result<Vec<u8>, CoreError> {
    let (m_cost, t_cost, p_cost) = match profile {
        "default" => (65536u32, 3u32, 1u32),
        "light" => (19456u32, 2u32, 1u32),
        other => return Err(CoreError::Argon2Profile(other.to_string())),
    };
    let params = argon2::Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|e| CoreError::Argon2(e.to_string()))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = vec![0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| CoreError::Argon2(e.to_string()))?;
    Ok(out)
}

const XNONCE_LEN: usize = 24;

/// XChaCha20-Poly1305 seal; random 24-byte nonce is prepended to the ciphertext.
pub fn seal(key32: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CoreError> {
    let key: [u8; 32] = key32
        .try_into()
        .map_err(|_| CoreError::Key("seal key must be 32 bytes".into()))?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let nonce_bytes = random_bytes(XNONCE_LEN)?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CoreError::Aead)?;
    let mut out = Vec::with_capacity(XNONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Open a sealed box produced by [`seal`].
pub fn open_sealed(key32: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, CoreError> {
    let key: [u8; 32] = key32
        .try_into()
        .map_err(|_| CoreError::Key("seal key must be 32 bytes".into()))?;
    if sealed.len() < XNONCE_LEN + 16 {
        return Err(CoreError::SealedTooShort);
    }
    let cipher = XChaCha20Poly1305::new(&key.into());
    let (nonce_bytes, ct) = sealed.split_at(XNONCE_LEN);
    cipher
        .decrypt(
            XNonce::from_slice(nonce_bytes),
            Payload { msg: ct, aad },
        )
        .map_err(|_| CoreError::Aead)
}
