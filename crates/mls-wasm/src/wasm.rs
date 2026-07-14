//! wasm-bindgen exports wrapping the pure-Rust internals in [`crate::core`].
//!
//! All binary parameters/returns are Uint8Array; errors surface as JsError with
//! descriptive messages. Snake_case export names are re-exported with camelCase
//! typed wrappers by @gathernet/mls-client.

use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::core::cert;
use crate::core::crypto;
use crate::core::device::{CoreDevice, MemberInfo, ProcessedResult};
use crate::core::error::CoreError;

fn js_err(e: CoreError) -> JsError {
    JsError::new(&e.to_string())
}

fn u8a(v: &[u8]) -> Uint8Array {
    Uint8Array::from(v)
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    // Reflect::set on a plain Object cannot fail.
    Reflect::set(obj, &JsValue::from_str(key), value).unwrap();
}

fn member_to_js(m: &MemberInfo) -> JsValue {
    let obj = Object::new();
    set(&obj, "accountId", &JsValue::from_str(&m.account_id));
    set(&obj, "deviceId", &JsValue::from_str(&m.device_id));
    set(&obj, "name", &JsValue::from_str(&m.name));
    obj.into()
}

fn members_to_js(members: &[MemberInfo]) -> Array {
    members.iter().map(member_to_js).collect()
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/// Generate a fresh BIP39 English 12-word mnemonic.
#[wasm_bindgen]
pub fn generate_mnemonic() -> Result<String, JsError> {
    crypto::generate_mnemonic().map_err(js_err)
}

/// Check whether a phrase is a valid BIP39 English mnemonic.
#[wasm_bindgen]
pub fn validate_mnemonic(phrase: &str) -> bool {
    crypto::validate_mnemonic(phrase)
}

/// Account identity keypair derived deterministically from a BIP39 mnemonic.
#[wasm_bindgen]
pub struct IdentityKeypair(crypto::IdentityKeypair);

#[wasm_bindgen]
impl IdentityKeypair {
    /// BIP39 seed (empty passphrase) -> HKDF-SHA256 -> Ed25519 signing key.
    pub fn from_mnemonic(phrase: &str) -> Result<IdentityKeypair, JsError> {
        crypto::IdentityKeypair::from_mnemonic(phrase)
            .map(IdentityKeypair)
            .map_err(js_err)
    }

    /// 32-byte raw Ed25519 public key.
    pub fn public_key(&self) -> Vec<u8> {
        self.0.public_key()
    }

    /// 64-byte Ed25519 signature over `msg`.
    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.0.sign(msg)
    }

    /// Domain-separated device certificate signature:
    /// Ed25519(IK, "gathernet-device-cert-v1" || cert_bytes).
    pub fn sign_device_cert(&self, cert_bytes: &[u8]) -> Vec<u8> {
        self.0.sign_device_cert(cert_bytes)
    }

    /// base58btc encoding of the public key.
    pub fn account_id(&self) -> String {
        self.0.account_id()
    }
}

/// Per-device Ed25519 keypair.
#[wasm_bindgen]
pub struct DeviceKeypair(crypto::DeviceKeypair);

#[wasm_bindgen]
impl DeviceKeypair {
    pub fn generate() -> Result<DeviceKeypair, JsError> {
        crypto::DeviceKeypair::generate()
            .map(DeviceKeypair)
            .map_err(js_err)
    }

    pub fn from_secret(bytes: &[u8]) -> Result<DeviceKeypair, JsError> {
        crypto::DeviceKeypair::from_secret(bytes)
            .map(DeviceKeypair)
            .map_err(js_err)
    }

    /// 32-byte Ed25519 seed.
    pub fn secret(&self) -> Vec<u8> {
        self.0.secret()
    }

    /// 32-byte raw Ed25519 public key.
    pub fn public_key(&self) -> Vec<u8> {
        self.0.public_key()
    }

    /// hex of the first 16 bytes of SHA-256(public key).
    pub fn device_id(&self) -> String {
        self.0.device_id()
    }
}

#[wasm_bindgen]
pub fn ed25519_sign(secret_seed: &[u8], msg: &[u8]) -> Result<Vec<u8>, JsError> {
    crypto::ed25519_sign(secret_seed, msg).map_err(js_err)
}

#[wasm_bindgen]
pub fn ed25519_verify(public: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    crypto::ed25519_verify(public, msg, sig)
}

/// Argon2id, 32-byte output. Profiles: "default" (m=65536 KiB, t=3, p=1),
/// "light" (m=19456 KiB, t=2, p=1).
#[wasm_bindgen]
pub fn argon2id_hash(password: &str, salt: &[u8], profile: &str) -> Result<Vec<u8>, JsError> {
    crypto::argon2id_hash(password, salt, profile).map_err(js_err)
}

/// XChaCha20-Poly1305 seal; random 24-byte nonce prepended to ciphertext.
#[wasm_bindgen]
pub fn seal(key32: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
    crypto::seal(key32, plaintext, aad).map_err(js_err)
}

/// Open a sealed box produced by `seal`.
#[wasm_bindgen]
pub fn open_sealed(key32: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
    crypto::open_sealed(key32, sealed, aad).map_err(js_err)
}

/// Deterministic CBOR device certificate:
/// [1, bytes(account_pk), bytes(device_pk), bytes(device_id), str(name), u64(created_at)].
#[wasm_bindgen]
pub fn encode_device_cert(
    account_pk: &[u8],
    device_pk: &[u8],
    name: &str,
    created_at_secs: u64,
) -> Result<Vec<u8>, JsError> {
    cert::encode_device_cert(account_pk, device_pk, name, created_at_secs).map_err(js_err)
}

fn cert_to_js(c: &cert::DeviceCert) -> JsValue {
    let obj = Object::new();
    set(&obj, "version", &JsValue::from_f64(c.version as f64));
    set(&obj, "accountPk", &u8a(&c.account_pk));
    set(&obj, "devicePk", &u8a(&c.device_pk));
    set(&obj, "deviceId", &JsValue::from_str(&c.device_id_hex()));
    set(&obj, "name", &JsValue::from_str(&c.name));
    set(&obj, "createdAt", &JsValue::from_f64(c.created_at as f64));
    obj.into()
}

/// Decode a device certificate (no signature verification).
#[wasm_bindgen]
pub fn decode_device_cert(bytes: &[u8]) -> Result<JsValue, JsError> {
    cert::decode_device_cert(bytes).map(|c| cert_to_js(&c)).map_err(js_err)
}

/// Build credential bytes: cert_bytes || 64-byte signature.
#[wasm_bindgen]
pub fn make_credential(cert_bytes: &[u8], cert_sig: &[u8]) -> Result<Vec<u8>, JsError> {
    cert::make_credential(cert_bytes, cert_sig).map_err(js_err)
}

/// Split, decode and VERIFY a credential; errors if the signature is invalid.
#[wasm_bindgen]
pub fn parse_credential(bytes: &[u8]) -> Result<JsValue, JsError> {
    let verified = cert::parse_and_verify_credential(bytes).map_err(js_err)?;
    let obj: Object = cert_to_js(&verified.cert).into();
    set(&obj, "sig", &u8a(&verified.sig));
    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// MLS device
// ---------------------------------------------------------------------------

fn processed_to_js(p: &ProcessedResult) -> JsValue {
    let obj = Object::new();
    set(&obj, "kind", &JsValue::from_str(p.kind.as_str()));
    if let Some(plaintext) = &p.plaintext {
        set(&obj, "plaintext", &u8a(plaintext));
    }
    if let Some(id) = &p.sender_device_id {
        set(&obj, "senderDeviceId", &JsValue::from_str(id));
    }
    if let Some(id) = &p.sender_account_id {
        set(&obj, "senderAccountId", &JsValue::from_str(id));
    }
    set(&obj, "epoch", &JsValue::from_f64(p.epoch as f64));
    if let Some(info) = &p.group_info {
        set(&obj, "groupInfo", &u8a(info));
    }
    set(&obj, "snapshot", &u8a(&p.snapshot));
    obj.into()
}

/// An MLS client bound to one device credential, over exportable in-memory storage.
#[wasm_bindgen]
pub struct MlsDevice(CoreDevice);

#[wasm_bindgen]
impl MlsDevice {
    /// Build from credential bytes (cert || sig) and the device's 32-byte Ed25519 seed.
    pub fn create(
        credential_bytes: &[u8],
        device_secret_seed: &[u8],
    ) -> Result<MlsDevice, JsError> {
        CoreDevice::create(credential_bytes, device_secret_seed)
            .map(MlsDevice)
            .map_err(js_err)
    }

    /// -> {ref: Uint8Array, message: Uint8Array, privateState: Uint8Array}
    pub fn generate_key_package(&self, last_resort: bool) -> Result<JsValue, JsError> {
        let result = self.0.generate_key_package(last_resort).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "ref", &u8a(&result.reference));
        set(&obj, "message", &u8a(&result.message));
        set(&obj, "privateState", &u8a(&result.private_state));
        Ok(obj.into())
    }

    /// Restore a key package private entry so a Welcome can still be processed.
    pub fn import_key_package_private(
        &self,
        ref_bytes: &[u8],
        private_state: &[u8],
    ) -> Result<(), JsError> {
        self.0
            .import_key_package_private(ref_bytes, private_state)
            .map_err(js_err)
    }

    /// -> {snapshot: Uint8Array}
    pub fn create_group(&self, group_id: &[u8]) -> Result<JsValue, JsError> {
        let snapshot = self.0.create_group(group_id).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "snapshot", &u8a(&snapshot));
        Ok(obj.into())
    }

    /// Import a snapshot and load the group.
    pub fn load_group(&self, group_id: &[u8], snapshot: &[u8]) -> Result<(), JsError> {
        self.0.load_group(group_id, snapshot).map_err(js_err)
    }

    /// -> {commit, welcomes: Array<Uint8Array>, groupInfo, snapshot}
    pub fn add_members(
        &self,
        group_id: &[u8],
        key_package_msgs: Vec<Uint8Array>,
    ) -> Result<JsValue, JsError> {
        let msgs: Vec<Vec<u8>> = key_package_msgs.iter().map(|m| m.to_vec()).collect();
        let result = self.0.add_members(group_id, &msgs).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "commit", &u8a(&result.commit));
        let welcomes: Array = result.welcomes.iter().map(|w| u8a(w)).collect();
        set(&obj, "welcomes", &welcomes);
        set(&obj, "groupInfo", &u8a(&result.group_info));
        set(&obj, "snapshot", &u8a(&result.snapshot));
        Ok(obj.into())
    }

    /// -> {commit, groupInfo, snapshot}; device ids are hex strings.
    pub fn remove_members(
        &self,
        group_id: &[u8],
        device_ids: Vec<String>,
    ) -> Result<JsValue, JsError> {
        let result = self.0.remove_members(group_id, &device_ids).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "commit", &u8a(&result.commit));
        set(&obj, "groupInfo", &u8a(&result.group_info));
        set(&obj, "snapshot", &u8a(&result.snapshot));
        Ok(obj.into())
    }

    /// -> {groupId, epoch, members: Array<{accountId, deviceId, name}>, snapshot}
    pub fn join_from_welcome(&self, welcome_msg: &[u8]) -> Result<JsValue, JsError> {
        let result = self.0.join_from_welcome(welcome_msg).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "groupId", &u8a(&result.group_id));
        set(&obj, "epoch", &JsValue::from_f64(result.epoch as f64));
        set(&obj, "members", &members_to_js(&result.members));
        set(&obj, "snapshot", &u8a(&result.snapshot));
        Ok(obj.into())
    }

    /// -> {groupId, commit, epoch, snapshot}
    pub fn external_join(&self, group_info_msg: &[u8]) -> Result<JsValue, JsError> {
        let result = self.0.external_join(group_info_msg).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "groupId", &u8a(&result.group_id));
        set(&obj, "commit", &u8a(&result.commit));
        set(&obj, "epoch", &JsValue::from_f64(result.epoch as f64));
        set(&obj, "snapshot", &u8a(&result.snapshot));
        Ok(obj.into())
    }

    /// -> {ciphertext, snapshot}. Persist the snapshot BEFORE releasing the ciphertext.
    pub fn encrypt(&self, group_id: &[u8], plaintext: &[u8]) -> Result<JsValue, JsError> {
        let result = self.0.encrypt(group_id, plaintext).map_err(js_err)?;
        let obj = Object::new();
        set(&obj, "ciphertext", &u8a(&result.ciphertext));
        set(&obj, "snapshot", &u8a(&result.snapshot));
        Ok(obj.into())
    }

    /// -> {kind, plaintext?, senderDeviceId?, senderAccountId?, epoch, groupInfo?, snapshot}
    pub fn process_incoming(&self, group_id: &[u8], message: &[u8]) -> Result<JsValue, JsError> {
        let result = self.0.process_incoming(group_id, message).map_err(js_err)?;
        Ok(processed_to_js(&result))
    }

    /// Serialized GroupInfo MlsMessage (ratchet tree included) for external joins.
    pub fn current_group_info(&self, group_id: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.current_group_info(group_id).map_err(js_err)
    }

    /// -> Array<{accountId, deviceId, name}>
    pub fn members(&self, group_id: &[u8]) -> Result<JsValue, JsError> {
        let members = self.0.members(group_id).map_err(js_err)?;
        Ok(members_to_js(&members).into())
    }

    pub fn current_epoch(&self, group_id: &[u8]) -> Result<f64, JsError> {
        self.0.current_epoch(group_id).map(|e| e as f64).map_err(js_err)
    }
}
