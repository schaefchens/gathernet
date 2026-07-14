use mls_rs::error::IntoAnyError;

/// Error type shared by all pure-Rust internals.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("invalid mnemonic: {0}")]
    Mnemonic(String),
    #[error("invalid key material: {0}")]
    Key(String),
    #[error("argon2 failure: {0}")]
    Argon2(String),
    #[error("unknown argon2 profile: {0}")]
    Argon2Profile(String),
    #[error("aead failure: sealed box could not be opened (wrong key, aad or tampered data)")]
    Aead,
    #[error("sealed data too short")]
    SealedTooShort,
    #[error("cbor error: {0}")]
    Cbor(String),
    #[error("invalid device certificate: {0}")]
    Cert(String),
    #[error("invalid credential: {0}")]
    Credential(String),
    #[error("credential signature verification failed")]
    CredentialSignature,
    #[error("leaf signature key does not match certified device key")]
    DeviceKeyMismatch,
    #[error("unsupported credential type")]
    UnsupportedCredential,
    #[error("mls error: {0}")]
    Mls(#[from] mls_rs::error::MlsError),
    #[error("mls codec error: {0}")]
    MlsCodec(#[from] mls_rs::mls_rs_codec::Error),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("group not found: {0}")]
    GroupNotFound(String),
    #[error("member not found for device id: {0}")]
    MemberNotFound(String),
    #[error("unexpected message type: {0}")]
    UnexpectedMessage(String),
    #[error("invalid snapshot: {0}")]
    Snapshot(String),
    #[error("random generator failure: {0}")]
    Rng(String),
}

impl IntoAnyError for CoreError {
    fn into_dyn_error(self) -> Result<Box<dyn std::error::Error + Send + Sync>, Self> {
        Ok(Box::new(self))
    }
}

impl From<minicbor::decode::Error> for CoreError {
    fn from(e: minicbor::decode::Error) -> Self {
        CoreError::Cbor(e.to_string())
    }
}
