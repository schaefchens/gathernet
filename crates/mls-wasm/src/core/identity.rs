//! Custom mls-rs IdentityProvider enforcing gathernet's credential rules:
//! - the BasicCredential identity bytes are `cert || sig` and the sig must verify
//!   under the account public key embedded in the cert;
//! - the leaf node's signature public key must equal the certified device key;
//! - a member's stable identity is its 16-byte device id;
//! - an external-commit successor is valid only for the same account key.

use mls_rs_core::extension::ExtensionList;
use mls_rs_core::identity::{
    CredentialType, MemberValidationContext, SigningIdentity,
};
use mls_rs_core::time::MlsTime;

use super::cert::{parse_and_verify_credential, VerifiedCredential};
use super::error::CoreError;

#[derive(Debug, Clone, Copy, Default)]
pub struct GathernetIdentityProvider;

/// Verify credential signature + device key binding for a signing identity.
pub fn verify_signing_identity(
    signing_identity: &SigningIdentity,
) -> Result<VerifiedCredential, CoreError> {
    let basic = signing_identity
        .credential
        .as_basic()
        .ok_or(CoreError::UnsupportedCredential)?;
    let verified = parse_and_verify_credential(&basic.identifier)?;
    if signing_identity.signature_key.as_ref() != verified.cert.device_pk.as_slice() {
        return Err(CoreError::DeviceKeyMismatch);
    }
    Ok(verified)
}

impl mls_rs::IdentityProvider for GathernetIdentityProvider {
    type Error = CoreError;

    fn validate_member(
        &self,
        signing_identity: &SigningIdentity,
        _timestamp: Option<MlsTime>,
        _context: MemberValidationContext<'_>,
    ) -> Result<(), Self::Error> {
        verify_signing_identity(signing_identity).map(|_| ())
    }

    fn validate_external_sender(
        &self,
        signing_identity: &SigningIdentity,
        _timestamp: Option<MlsTime>,
        _extensions: Option<&ExtensionList>,
    ) -> Result<(), Self::Error> {
        verify_signing_identity(signing_identity).map(|_| ())
    }

    fn identity(
        &self,
        signing_identity: &SigningIdentity,
        _extensions: &ExtensionList,
    ) -> Result<Vec<u8>, Self::Error> {
        let verified = verify_signing_identity(signing_identity)?;
        Ok(verified.cert.device_id.to_vec())
    }

    fn valid_successor(
        &self,
        predecessor: &SigningIdentity,
        successor: &SigningIdentity,
        _extensions: &ExtensionList,
    ) -> Result<bool, Self::Error> {
        let pred = verify_signing_identity(predecessor)?;
        let succ = verify_signing_identity(successor)?;
        Ok(pred.cert.account_pk == succ.cert.account_pk)
    }

    fn supported_types(&self) -> Vec<CredentialType> {
        vec![CredentialType::BASIC]
    }
}
