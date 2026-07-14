//! In-memory, exportable mls-rs storage.
//!
//! Group state and key package private data live in `Arc<Mutex<HashMap>>` so a
//! single storage handle can be shared with the mls-rs client while the device
//! wrapper exports/imports serialized snapshots per group.
//!
//! Snapshot format (CBOR): `[version(1), bytes(group_state), [[epoch_id, bytes(epoch_data)]...]]`

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

use mls_rs::mls_rs_codec::{MlsDecode, MlsEncode};
use mls_rs_core::group::{EpochRecord, GroupState};
use mls_rs_core::key_package::KeyPackageData;
use mls_rs_core::psk::{ExternalPskId, PreSharedKey};
use zeroize::Zeroizing;

use super::error::CoreError;

/// Bounded number of prior epochs retained per group (out-of-order decryption window).
pub const MAX_EPOCH_RETENTION: usize = 3;

const SNAPSHOT_VERSION: u8 = 1;

#[derive(Default)]
struct GroupRecord {
    state: Vec<u8>,
    epochs: BTreeMap<u64, Vec<u8>>,
}

#[derive(Default)]
struct StorageInner {
    groups: HashMap<Vec<u8>, GroupRecord>,
    key_packages: HashMap<Vec<u8>, KeyPackageData>,
    /// Reference of the most recently inserted key package (used by
    /// `generate_key_package` to hand the private entry back to the caller).
    last_key_package_ref: Option<Vec<u8>>,
}

#[derive(Clone, Default)]
pub struct ExportableStorage {
    inner: Arc<Mutex<StorageInner>>,
}

impl ExportableStorage {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, StorageInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reference and serialized private data of the most recently generated key package.
    pub fn take_last_key_package(&self) -> Result<(Vec<u8>, Vec<u8>), CoreError> {
        let mut inner = self.lock();
        let id = inner
            .last_key_package_ref
            .take()
            .ok_or_else(|| CoreError::Storage("no key package was generated".into()))?;
        let data = inner
            .key_packages
            .get(&id)
            .ok_or_else(|| CoreError::Storage("key package data missing".into()))?;
        let bytes = data.mls_encode_to_vec()?;
        Ok((id, bytes))
    }

    /// Restore a key package private entry previously returned by `take_last_key_package`.
    pub fn import_key_package(&self, id: &[u8], private_state: &[u8]) -> Result<(), CoreError> {
        let data = KeyPackageData::mls_decode(&mut &*private_state)?;
        self.lock().key_packages.insert(id.to_vec(), data);
        Ok(())
    }

    /// Export the serialized state of one group (current state + retained epochs).
    pub fn export_group_snapshot(&self, group_id: &[u8]) -> Result<Vec<u8>, CoreError> {
        let inner = self.lock();
        let record = inner
            .groups
            .get(group_id)
            .ok_or_else(|| CoreError::GroupNotFound(hex::encode(group_id)))?;
        let mut buf = Vec::new();
        let mut enc = minicbor::Encoder::new(&mut buf);
        enc.array(3)
            .and_then(|e| e.u8(SNAPSHOT_VERSION))
            .and_then(|e| e.bytes(&record.state))
            .and_then(|e| e.array(record.epochs.len() as u64))
            .map_err(|e| CoreError::Cbor(e.to_string()))?;
        for (id, data) in &record.epochs {
            enc.array(2)
                .and_then(|e| e.u64(*id))
                .and_then(|e| e.bytes(data))
                .map_err(|e| CoreError::Cbor(e.to_string()))?;
        }
        Ok(buf)
    }

    /// Import a snapshot produced by [`export_group_snapshot`], replacing any
    /// existing record for that group.
    pub fn import_group_snapshot(
        &self,
        group_id: &[u8],
        snapshot: &[u8],
    ) -> Result<(), CoreError> {
        let mut dec = minicbor::Decoder::new(snapshot);
        if dec.array()? != Some(3) {
            return Err(CoreError::Snapshot("expected 3-element array".into()));
        }
        let version = dec.u8()?;
        if version != SNAPSHOT_VERSION {
            return Err(CoreError::Snapshot(format!(
                "unsupported snapshot version {version}"
            )));
        }
        let state = dec.bytes()?.to_vec();
        let epoch_count = dec
            .array()?
            .ok_or_else(|| CoreError::Snapshot("indefinite epoch array".into()))?;
        let mut epochs = BTreeMap::new();
        for _ in 0..epoch_count {
            if dec.array()? != Some(2) {
                return Err(CoreError::Snapshot("expected [id, data] pair".into()));
            }
            let id = dec.u64()?;
            let data = dec.bytes()?.to_vec();
            epochs.insert(id, data);
        }
        self.lock()
            .groups
            .insert(group_id.to_vec(), GroupRecord { state, epochs });
        Ok(())
    }
}

impl mls_rs::GroupStateStorage for ExportableStorage {
    type Error = CoreError;

    fn state(&self, group_id: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self
            .lock()
            .groups
            .get(group_id)
            .map(|r| Zeroizing::new(r.state.clone())))
    }

    fn epoch(
        &self,
        group_id: &[u8],
        epoch_id: u64,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self
            .lock()
            .groups
            .get(group_id)
            .and_then(|r| r.epochs.get(&epoch_id))
            .map(|d| Zeroizing::new(d.clone())))
    }

    fn write(
        &mut self,
        state: GroupState,
        epoch_inserts: Vec<EpochRecord>,
        epoch_updates: Vec<EpochRecord>,
    ) -> Result<(), Self::Error> {
        let mut inner = self.lock();
        let record = inner.groups.entry(state.id).or_default();
        record.state = state.data.to_vec();
        for epoch in epoch_inserts {
            record.epochs.insert(epoch.id, epoch.data.to_vec());
        }
        for epoch in epoch_updates {
            if let Some(existing) = record.epochs.get_mut(&epoch.id) {
                *existing = epoch.data.to_vec();
            }
        }
        // Bounded retention of prior epochs.
        while record.epochs.len() > MAX_EPOCH_RETENTION {
            let oldest = *record.epochs.keys().next().expect("non-empty");
            record.epochs.remove(&oldest);
        }
        Ok(())
    }

    fn max_epoch_id(&self, group_id: &[u8]) -> Result<Option<u64>, Self::Error> {
        Ok(self
            .lock()
            .groups
            .get(group_id)
            .and_then(|r| r.epochs.keys().next_back().copied()))
    }
}

impl mls_rs::KeyPackageStorage for ExportableStorage {
    type Error = CoreError;

    fn delete(&mut self, id: &[u8]) -> Result<(), Self::Error> {
        self.lock().key_packages.remove(id);
        Ok(())
    }

    fn insert(&mut self, id: Vec<u8>, pkg: KeyPackageData) -> Result<(), Self::Error> {
        let mut inner = self.lock();
        inner.last_key_package_ref = Some(id.clone());
        inner.key_packages.insert(id, pkg);
        Ok(())
    }

    fn get(&self, id: &[u8]) -> Result<Option<KeyPackageData>, Self::Error> {
        Ok(self.lock().key_packages.get(id).cloned())
    }
}

/// No-op PSK storage: gathernet does not use external PSKs.
impl mls_rs::PreSharedKeyStorage for ExportableStorage {
    type Error = CoreError;

    fn get(&self, _id: &ExternalPskId) -> Result<Option<PreSharedKey>, Self::Error> {
        Ok(None)
    }
}
