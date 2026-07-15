//! MLS device: a configured mls-rs client over exportable in-memory storage.
//!
//! Every mutating group operation returns a `snapshot`: the serialized state of
//! that group (current state + retained prior epochs) taken AFTER
//! `group.write_to_storage()`. Callers must persist the snapshot before
//! releasing any ciphertext produced by the same call (crash consistency).

use mls_rs::client_builder::{
    BaseConfig, WithCryptoProvider, WithGroupStateStorage, WithIdentityProvider,
    WithKeyPackageRepo, WithPskStore,
};
use mls_rs::error::MlsError;
use mls_rs::extension::recommended::LastResortKeyPackageExt;
use mls_rs::extension::ExtensionType;
use mls_rs::group::{Group, ReceivedMessage};
use mls_rs::identity::basic::BasicCredential;
use mls_rs::identity::SigningIdentity;
use mls_rs::{CipherSuite, Client, CryptoProvider, ExtensionList, MlsMessage};
use mls_rs_core::crypto::{CipherSuiteProvider, SignatureSecretKey};
use mls_rs_crypto_rustcrypto::RustCryptoProvider;

use super::cert::parse_and_verify_credential;
use super::error::CoreError;
use super::identity::GathernetIdentityProvider;
use super::storage::ExportableStorage;

/// MLS ciphersuite 3: X25519 / ChaCha20-Poly1305 / Ed25519 / SHA-256.
pub const CIPHERSUITE: CipherSuite = CipherSuite::CURVE25519_CHACHA;

/// Key package lifetime: 90 days.
const KEY_PACKAGE_LIFETIME_SECS: u64 = 90 * 24 * 60 * 60;

type DeviceConfig = WithKeyPackageRepo<
    ExportableStorage,
    WithPskStore<
        ExportableStorage,
        WithGroupStateStorage<
            ExportableStorage,
            WithIdentityProvider<
                GathernetIdentityProvider,
                WithCryptoProvider<RustCryptoProvider, BaseConfig>,
            >,
        >,
    >,
>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberInfo {
    /// base58 of the account public key.
    pub account_id: String,
    /// hex of the 16-byte device id.
    pub device_id: String,
    /// Device name from the certificate.
    pub name: String,
}

#[derive(Debug)]
pub struct KeyPackageResult {
    /// Key package reference (storage id / hash).
    pub reference: Vec<u8>,
    /// Serialized MlsMessage containing the key package.
    pub message: Vec<u8>,
    /// Serialized private entry (KeyPackageData) to persist until the Welcome arrives.
    pub private_state: Vec<u8>,
}

#[derive(Debug)]
pub struct AddMembersResult {
    pub commit: Vec<u8>,
    pub welcomes: Vec<Vec<u8>>,
    pub group_info: Vec<u8>,
    pub snapshot: Vec<u8>,
}

#[derive(Debug)]
pub struct RemoveMembersResult {
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
    pub snapshot: Vec<u8>,
}

#[derive(Debug)]
pub struct JoinResult {
    pub group_id: Vec<u8>,
    pub epoch: u64,
    pub members: Vec<MemberInfo>,
    pub snapshot: Vec<u8>,
}

#[derive(Debug)]
pub struct ExternalJoinResult {
    pub group_id: Vec<u8>,
    pub commit: Vec<u8>,
    pub epoch: u64,
    pub snapshot: Vec<u8>,
}

#[derive(Debug)]
pub struct EncryptResult {
    pub ciphertext: Vec<u8>,
    pub snapshot: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessedKind {
    Application,
    Commit,
    Proposal,
}

impl ProcessedKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProcessedKind::Application => "application",
            ProcessedKind::Commit => "commit",
            ProcessedKind::Proposal => "proposal",
        }
    }
}

#[derive(Debug)]
pub struct ProcessedResult {
    pub kind: ProcessedKind,
    pub plaintext: Option<Vec<u8>>,
    pub sender_device_id: Option<String>,
    pub sender_account_id: Option<String>,
    pub epoch: u64,
    /// Fresh group info after applying a commit, so the client can re-publish it.
    pub group_info: Option<Vec<u8>>,
    pub snapshot: Vec<u8>,
}

pub struct CoreDevice {
    client: Client<DeviceConfig>,
    storage: ExportableStorage,
}

impl CoreDevice {
    /// Build an MLS client from credential bytes (cert || sig) and the device's
    /// 32-byte Ed25519 secret seed.
    pub fn create(credential_bytes: &[u8], device_secret_seed: &[u8]) -> Result<Self, CoreError> {
        // Validate the credential and bind it to the device key.
        let verified = parse_and_verify_credential(credential_bytes)?;
        let seed: [u8; 32] = device_secret_seed
            .try_into()
            .map_err(|_| CoreError::Key("device secret must be 32 bytes".into()))?;
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let public_bytes = signing_key.verifying_key().to_bytes();
        if verified.cert.device_pk != public_bytes {
            return Err(CoreError::DeviceKeyMismatch);
        }

        // RustCryptoProvider expects Ed25519 secrets as 64-byte keypair bytes (seed || public).
        let secret = SignatureSecretKey::from(signing_key.to_keypair_bytes().to_vec());
        let crypto_provider = RustCryptoProvider::default();

        // Sanity check: the provider derives the same public key as ed25519-dalek.
        let cs = crypto_provider
            .cipher_suite_provider(CIPHERSUITE)
            .ok_or_else(|| CoreError::Key("ciphersuite 3 unsupported by provider".into()))?;
        let derived = cs
            .signature_key_derive_public(&secret)
            .map_err(|e| CoreError::Key(format!("public key derivation failed: {e:?}")))?;
        if derived.as_ref() != public_bytes.as_slice() {
            return Err(CoreError::Key(
                "provider-derived public key mismatch".into(),
            ));
        }

        let signing_identity = SigningIdentity::new(
            BasicCredential::new(credential_bytes.to_vec()).into_credential(),
            public_bytes.to_vec().into(),
        );

        let storage = ExportableStorage::new();
        let client = Client::builder()
            .crypto_provider(crypto_provider)
            .identity_provider(GathernetIdentityProvider)
            .group_state_storage(storage.clone())
            .psk_store(storage.clone())
            .key_package_repo(storage.clone())
            .key_package_lifetime(std::time::Duration::from_secs(KEY_PACKAGE_LIFETIME_SECS))
            .extension_type(ExtensionType::LAST_RESORT_KEY_PACKAGE)
            .signing_identity(signing_identity, secret, CIPHERSUITE)
            .build();

        Ok(Self { client, storage })
    }

    fn load(&self, group_id: &[u8]) -> Result<Group<DeviceConfig>, CoreError> {
        self.client.load_group(group_id).map_err(|e| match e {
            MlsError::GroupNotFound => CoreError::GroupNotFound(hex::encode(group_id)),
            other => CoreError::Mls(other),
        })
    }

    fn snapshot_after_write(
        &self,
        group: &mut Group<DeviceConfig>,
    ) -> Result<Vec<u8>, CoreError> {
        group.write_to_storage()?;
        self.storage.export_group_snapshot(&group.group_id().to_vec())
    }

    pub fn generate_key_package(&self, last_resort: bool) -> Result<KeyPackageResult, CoreError> {
        let mut kp_extensions = ExtensionList::new();
        if last_resort {
            kp_extensions
                .set_from(LastResortKeyPackageExt)
                .map_err(|e| CoreError::Storage(format!("extension encode failed: {e:?}")))?;
        }
        let message = self.client.generate_key_package_message(
            kp_extensions,
            ExtensionList::new(),
            None,
        )?;
        let (reference, private_state) = self.storage.take_last_key_package()?;
        Ok(KeyPackageResult {
            reference,
            message: message.to_bytes()?,
            private_state,
        })
    }

    pub fn import_key_package_private(
        &self,
        reference: &[u8],
        private_state: &[u8],
    ) -> Result<(), CoreError> {
        self.storage.import_key_package(reference, private_state)
    }

    /// Create a new group; returns the exported snapshot.
    pub fn create_group(&self, group_id: &[u8]) -> Result<Vec<u8>, CoreError> {
        let mut group = self.client.create_group_with_id(
            group_id.to_vec(),
            ExtensionList::new(),
            ExtensionList::new(),
            None,
        )?;
        self.snapshot_after_write(&mut group)
    }

    /// Import a snapshot into storage and verify the group loads.
    pub fn load_group(&self, group_id: &[u8], snapshot: &[u8]) -> Result<(), CoreError> {
        self.storage.import_group_snapshot(group_id, snapshot)?;
        self.load(group_id)?;
        Ok(())
    }

    pub fn add_members(
        &self,
        group_id: &[u8],
        key_package_msgs: &[Vec<u8>],
    ) -> Result<AddMembersResult, CoreError> {
        let mut group = self.load(group_id)?;
        let mut builder = group.commit_builder();
        for msg_bytes in key_package_msgs {
            builder = builder.add_member(MlsMessage::from_bytes(msg_bytes)?)?;
        }
        let output = builder.build()?;
        let commit = output.commit_message().to_bytes()?;
        let welcomes = output
            .welcome_messages()
            .iter()
            .map(|w| w.to_bytes())
            .collect::<Result<Vec<_>, _>>()?;
        // Self-apply: the committer moves to the new epoch.
        group.apply_pending_commit()?;
        let group_info = group
            .group_info_message_allowing_ext_commit(true)?
            .to_bytes()?;
        let snapshot = self.snapshot_after_write(&mut group)?;
        Ok(AddMembersResult {
            commit,
            welcomes,
            group_info,
            snapshot,
        })
    }

    pub fn remove_members(
        &self,
        group_id: &[u8],
        device_ids_hex: &[String],
    ) -> Result<RemoveMembersResult, CoreError> {
        let mut group = self.load(group_id)?;
        let mut indices = Vec::with_capacity(device_ids_hex.len());
        for wanted in device_ids_hex {
            let index = group
                .roster()
                .members_iter()
                .find_map(|member| {
                    let verified =
                        parse_and_verify_credential(member.signing_identity.credential.as_basic()?.identifier.as_slice())
                            .ok()?;
                    (verified.cert.device_id_hex() == *wanted).then_some(member.index)
                })
                .ok_or_else(|| CoreError::MemberNotFound(wanted.clone()))?;
            indices.push(index);
        }
        let mut builder = group.commit_builder();
        for index in indices {
            builder = builder.remove_member(index)?;
        }
        let output = builder.build()?;
        let commit = output.commit_message().to_bytes()?;
        group.apply_pending_commit()?;
        let group_info = group
            .group_info_message_allowing_ext_commit(true)?
            .to_bytes()?;
        let snapshot = self.snapshot_after_write(&mut group)?;
        Ok(RemoveMembersResult {
            commit,
            group_info,
            snapshot,
        })
    }

    pub fn join_from_welcome(&self, welcome_msg: &[u8]) -> Result<JoinResult, CoreError> {
        let welcome = MlsMessage::from_bytes(welcome_msg)?;
        let (mut group, _info) = self.client.join_group(None, &welcome, None)?;
        let group_id = group.group_id().to_vec();
        let epoch = group.current_epoch();
        let members = members_of(&group)?;
        let snapshot = self.snapshot_after_write(&mut group)?;
        Ok(JoinResult {
            group_id,
            epoch,
            members,
            snapshot,
        })
    }

    pub fn external_join(&self, group_info_msg: &[u8]) -> Result<ExternalJoinResult, CoreError> {
        let info = MlsMessage::from_bytes(group_info_msg)?;
        let (mut group, commit) = self.client.commit_external(info)?;
        let group_id = group.group_id().to_vec();
        let epoch = group.current_epoch();
        let commit = commit.to_bytes()?;
        let snapshot = self.snapshot_after_write(&mut group)?;
        Ok(ExternalJoinResult {
            group_id,
            commit,
            epoch,
            snapshot,
        })
    }

    pub fn encrypt(&self, group_id: &[u8], plaintext: &[u8]) -> Result<EncryptResult, CoreError> {
        let mut group = self.load(group_id)?;
        let message = group.encrypt_application_message(plaintext, Vec::new())?;
        let ciphertext = message.to_bytes()?;
        let snapshot = self.snapshot_after_write(&mut group)?;
        Ok(EncryptResult {
            ciphertext,
            snapshot,
        })
    }

    pub fn process_incoming(
        &self,
        group_id: &[u8],
        message: &[u8],
    ) -> Result<ProcessedResult, CoreError> {
        let mut group = self.load(group_id)?;
        let received = group.process_incoming_message(MlsMessage::from_bytes(message)?)?;
        let result = match received {
            ReceivedMessage::ApplicationMessage(desc) => {
                let sender = member_info_at(&group, desc.sender_index);
                ProcessedResult {
                    kind: ProcessedKind::Application,
                    plaintext: Some(desc.data().to_vec()),
                    sender_device_id: sender.as_ref().map(|m| m.device_id.clone()),
                    sender_account_id: sender.map(|m| m.account_id),
                    epoch: group.current_epoch(),
                    group_info: None,
                    snapshot: Vec::new(),
                }
            }
            ReceivedMessage::Commit(desc) => {
                let sender = member_info_at(&group, desc.committer);
                let group_info = group
                    .group_info_message_allowing_ext_commit(true)?
                    .to_bytes()?;
                ProcessedResult {
                    kind: ProcessedKind::Commit,
                    plaintext: None,
                    sender_device_id: sender.as_ref().map(|m| m.device_id.clone()),
                    sender_account_id: sender.map(|m| m.account_id),
                    epoch: group.current_epoch(),
                    group_info: Some(group_info),
                    snapshot: Vec::new(),
                }
            }
            ReceivedMessage::Proposal(_) => ProcessedResult {
                kind: ProcessedKind::Proposal,
                plaintext: None,
                sender_device_id: None,
                sender_account_id: None,
                epoch: group.current_epoch(),
                group_info: None,
                snapshot: Vec::new(),
            },
            other => {
                return Err(CoreError::UnexpectedMessage(format!("{other:?}")));
            }
        };
        let snapshot = self.snapshot_after_write(&mut group)?;
        Ok(ProcessedResult { snapshot, ..result })
    }

    /// RFC 9420 exporter: derive a secret for use outside of MLS, bound to the
    /// group's current epoch. Each (epoch, label, context) combination yields a
    /// unique, independent secret; all members at the same epoch derive the
    /// same bytes. NON-MUTATING: reads the group from storage without writing
    /// back, so no snapshot is produced.
    pub fn export_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        len: u32,
    ) -> Result<Vec<u8>, CoreError> {
        let group = self.load(group_id)?;
        let secret = group.export_secret(label.as_bytes(), context, len as usize)?;
        Ok(secret.as_bytes().to_vec())
    }

    pub fn current_group_info(&self, group_id: &[u8]) -> Result<Vec<u8>, CoreError> {
        let group = self.load(group_id)?;
        Ok(group
            .group_info_message_allowing_ext_commit(true)?
            .to_bytes()?)
    }

    pub fn members(&self, group_id: &[u8]) -> Result<Vec<MemberInfo>, CoreError> {
        let group = self.load(group_id)?;
        members_of(&group)
    }

    pub fn current_epoch(&self, group_id: &[u8]) -> Result<u64, CoreError> {
        Ok(self.load(group_id)?.current_epoch())
    }
}

fn member_info_at(group: &Group<DeviceConfig>, index: u32) -> Option<MemberInfo> {
    let member = group.member_at_index(index)?;
    let basic = member.signing_identity.credential.as_basic()?;
    let verified = parse_and_verify_credential(&basic.identifier).ok()?;
    Some(MemberInfo {
        account_id: verified.cert.account_id(),
        device_id: verified.cert.device_id_hex(),
        name: verified.cert.name,
    })
}

fn members_of(group: &Group<DeviceConfig>) -> Result<Vec<MemberInfo>, CoreError> {
    group
        .roster()
        .members_iter()
        .map(|member| {
            let basic = member
                .signing_identity
                .credential
                .as_basic()
                .ok_or(CoreError::UnsupportedCredential)?;
            let verified = parse_and_verify_credential(&basic.identifier)?;
            Ok(MemberInfo {
                account_id: verified.cert.account_id(),
                device_id: verified.cert.device_id_hex(),
                name: verified.cert.name,
            })
        })
        .collect()
}
