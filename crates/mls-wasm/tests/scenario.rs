//! Native (non-wasm) tests exercising the full multi-device MLS scenario plus
//! the crypto helpers. These run with plain `cargo test`.

use mls_wasm::core::cert::{
    decode_device_cert, encode_device_cert, make_credential, parse_and_verify_credential,
};
use mls_wasm::core::crypto::{
    argon2id_hash, derive_storage_root, ed25519_sign, ed25519_verify, generate_mnemonic,
    open_sealed, seal, validate_mnemonic, DeviceKeypair, IdentityKeypair, IDENTITY_HKDF_INFO,
    IDENTITY_HKDF_SALT,
};
use mls_wasm::core::device::CoreDevice;

const PHRASE_A: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PHRASE_B: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

struct TestDevice {
    core: CoreDevice,
    credential: Vec<u8>,
    secret: Vec<u8>,
    device_id: String,
}

fn make_device(identity: &IdentityKeypair, name: &str) -> TestDevice {
    let dk = DeviceKeypair::generate().unwrap();
    let cert = encode_device_cert(&identity.public_key(), &dk.public_key(), name, 1_700_000_000)
        .unwrap();
    let sig = identity.sign_device_cert(&cert);
    let credential = make_credential(&cert, &sig).unwrap();
    let core = CoreDevice::create(&credential, &dk.secret()).unwrap();
    TestDevice {
        core,
        credential,
        secret: dk.secret(),
        device_id: dk.device_id(),
    }
}

#[test]
fn mnemonic_determinism_and_validation() {
    let generated = generate_mnemonic().unwrap();
    assert_eq!(generated.split_whitespace().count(), 12);
    assert!(validate_mnemonic(&generated));
    assert!(!validate_mnemonic("not a valid mnemonic phrase at all"));

    let a1 = IdentityKeypair::from_mnemonic(PHRASE_A).unwrap();
    let a2 = IdentityKeypair::from_mnemonic(PHRASE_A).unwrap();
    let b = IdentityKeypair::from_mnemonic(PHRASE_B).unwrap();
    assert_eq!(a1.account_id(), a2.account_id());
    assert_eq!(a1.public_key(), a2.public_key());
    assert_ne!(a1.account_id(), b.account_id());
    assert_eq!(a1.public_key().len(), 32);

    // Signatures verify under the public key.
    let sig = a1.sign(b"hello");
    assert_eq!(sig.len(), 64);
    assert!(ed25519_verify(&a1.public_key(), b"hello", &sig));
    assert!(!ed25519_verify(&a1.public_key(), b"other", &sig));
}

#[test]
fn ed25519_seed_sign_roundtrip() {
    let dk = DeviceKeypair::generate().unwrap();
    let sig = ed25519_sign(&dk.secret(), b"msg").unwrap();
    assert!(ed25519_verify(&dk.public_key(), b"msg", &sig));

    let dk2 = DeviceKeypair::from_secret(&dk.secret()).unwrap();
    assert_eq!(dk.public_key(), dk2.public_key());
    assert_eq!(dk.device_id(), dk2.device_id());
    assert_eq!(dk.device_id().len(), 32); // 16 bytes hex-encoded
}

#[test]
fn argon2_profiles() {
    let salt = b"0123456789abcdef";
    let light = argon2id_hash("password", salt, "light").unwrap();
    let light2 = argon2id_hash("password", salt, "light").unwrap();
    assert_eq!(light.len(), 32);
    assert_eq!(light, light2);

    let default = argon2id_hash("password", salt, "default").unwrap();
    assert_eq!(default.len(), 32);
    assert_ne!(light, default);

    assert!(argon2id_hash("password", salt, "bogus").is_err());
    let other_salt = argon2id_hash("password", b"fedcba9876543210", "light").unwrap();
    assert_ne!(light, other_salt);
}

#[test]
fn seal_open_roundtrip_and_tamper_rejection() {
    let key = [7u8; 32];
    let sealed = seal(&key, b"secret payload", b"aad").unwrap();
    assert_eq!(
        open_sealed(&key, &sealed, b"aad").unwrap(),
        b"secret payload"
    );

    // Nonce is random: sealing twice differs.
    let sealed2 = seal(&key, b"secret payload", b"aad").unwrap();
    assert_ne!(sealed, sealed2);

    // Tampered ciphertext rejected.
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(open_sealed(&key, &tampered, b"aad").is_err());

    // Wrong aad rejected.
    assert!(open_sealed(&key, &sealed, b"other aad").is_err());

    // Wrong key rejected.
    assert!(open_sealed(&[8u8; 32], &sealed, b"aad").is_err());
}

#[test]
fn device_cert_roundtrip_and_credential_verification() {
    let identity = IdentityKeypair::from_mnemonic(PHRASE_A).unwrap();
    let dk = DeviceKeypair::generate().unwrap();
    let cert_bytes =
        encode_device_cert(&identity.public_key(), &dk.public_key(), "laptop", 1234567890)
            .unwrap();

    let cert = decode_device_cert(&cert_bytes).unwrap();
    assert_eq!(cert.version, 1);
    assert_eq!(cert.account_pk, identity.public_key());
    assert_eq!(cert.device_pk, dk.public_key());
    assert_eq!(cert.device_id_hex(), dk.device_id());
    assert_eq!(cert.name, "laptop");
    assert_eq!(cert.created_at, 1234567890);
    assert_eq!(cert.account_id(), identity.account_id());

    let sig = identity.sign_device_cert(&cert_bytes);
    let credential = make_credential(&cert_bytes, &sig).unwrap();
    let verified = parse_and_verify_credential(&credential).unwrap();
    assert_eq!(verified.cert, cert);

    // Signature by the wrong identity is rejected.
    let other = IdentityKeypair::from_mnemonic(PHRASE_B).unwrap();
    let bad_sig = other.sign_device_cert(&cert_bytes);
    let bad_credential = make_credential(&cert_bytes, &bad_sig).unwrap();
    assert!(parse_and_verify_credential(&bad_credential).is_err());

    // Corrupted credential bytes are rejected.
    let mut corrupted = credential.clone();
    corrupted[10] ^= 1;
    assert!(parse_and_verify_credential(&corrupted).is_err());
}

#[test]
fn full_multi_device_scenario() {
    let alice = IdentityKeypair::from_mnemonic(PHRASE_A).unwrap();
    let bob = IdentityKeypair::from_mnemonic(PHRASE_B).unwrap();

    let alice1 = make_device(&alice, "alice-laptop");
    let alice2 = make_device(&alice, "alice-phone");
    let bob1 = make_device(&bob, "bob-laptop");
    let bob2 = make_device(&bob, "bob-phone");

    let group_id = b"gathernet-test-group";

    // Alice-1 creates the group.
    alice1.core.create_group(group_id).unwrap();
    assert_eq!(alice1.core.current_epoch(group_id).unwrap(), 0);

    // Alice-2 and Bob-1 publish key packages. Exercise the persist/import path
    // for Alice-2: pretend the app restarted between publishing the key package
    // and receiving the welcome.
    let alice2_kp = alice2.core.generate_key_package(false).unwrap();
    let alice2_restarted = CoreDevice::create(&alice2.credential, &alice2.secret).unwrap();
    let bob1_kp = bob1.core.generate_key_package(true).unwrap();
    assert!(!alice2_kp.reference.is_empty());
    assert!(!alice2_kp.private_state.is_empty());

    // Alice-1 adds both.
    let add = alice1
        .core
        .add_members(
            group_id,
            &[alice2_kp.message.clone(), bob1_kp.message.clone()],
        )
        .unwrap();
    assert_eq!(alice1.core.current_epoch(group_id).unwrap(), 1);
    assert!(!add.welcomes.is_empty());
    assert!(!add.group_info.is_empty());

    // Alice-2 joins via the restarted device using imported private state.
    alice2_restarted
        .import_key_package_private(&alice2_kp.reference, &alice2_kp.private_state)
        .unwrap();
    let alice2 = TestDevice {
        core: alice2_restarted,
        credential: alice2.credential,
        secret: alice2.secret,
        device_id: alice2.device_id,
    };
    let join_a2 = alice2.core.join_from_welcome(&add.welcomes[0]).unwrap();
    assert_eq!(join_a2.group_id, group_id);
    assert_eq!(join_a2.epoch, 1);
    assert_eq!(join_a2.members.len(), 3);

    let join_b1 = bob1.core.join_from_welcome(&add.welcomes[0]).unwrap();
    assert_eq!(join_b1.epoch, 1);

    // Everyone exchanges messages.
    let msg1 = alice1.core.encrypt(group_id, b"hello from alice-1").unwrap();
    let p_a2 = alice2.core.process_incoming(group_id, &msg1.ciphertext).unwrap();
    assert_eq!(p_a2.kind.as_str(), "application");
    assert_eq!(p_a2.plaintext.as_deref(), Some(b"hello from alice-1".as_slice()));
    assert_eq!(p_a2.sender_device_id.as_deref(), Some(alice1.device_id.as_str()));
    assert_eq!(p_a2.sender_account_id.as_deref(), Some(alice.account_id().as_str()));
    let p_b1 = bob1.core.process_incoming(group_id, &msg1.ciphertext).unwrap();
    assert_eq!(p_b1.plaintext.as_deref(), Some(b"hello from alice-1".as_slice()));

    let msg2 = bob1.core.encrypt(group_id, b"hello from bob-1").unwrap();
    let p1 = alice1.core.process_incoming(group_id, &msg2.ciphertext).unwrap();
    assert_eq!(p1.plaintext.as_deref(), Some(b"hello from bob-1".as_slice()));
    let p2 = alice2.core.process_incoming(group_id, &msg2.ciphertext).unwrap();
    assert_eq!(p2.plaintext.as_deref(), Some(b"hello from bob-1".as_slice()));

    // Bob-2 external-joins from the published group info.
    let ext = bob2.core.external_join(&add.group_info).unwrap();
    assert_eq!(ext.group_id, group_id);
    assert_eq!(ext.epoch, 2);

    // Existing members process Bob-2's external commit.
    for device in [&alice1, &alice2, &bob1] {
        let p = device.core.process_incoming(group_id, &ext.commit).unwrap();
        assert_eq!(p.kind.as_str(), "commit");
        assert_eq!(p.epoch, 2);
        assert!(p.group_info.is_some());
        assert_eq!(p.sender_device_id.as_deref(), Some(bob2.device_id.as_str()));
    }
    assert_eq!(alice1.core.current_epoch(group_id).unwrap(), 2);

    // Bob-2 decrypts new messages.
    let msg3 = alice2.core.encrypt(group_id, b"welcome bob-2").unwrap();
    let p_b2 = bob2.core.process_incoming(group_id, &msg3.ciphertext).unwrap();
    assert_eq!(p_b2.plaintext.as_deref(), Some(b"welcome bob-2".as_slice()));
    alice1.core.process_incoming(group_id, &msg3.ciphertext).unwrap();
    bob1.core.process_incoming(group_id, &msg3.ciphertext).unwrap();

    // Membership is visible with parsed identities.
    let members = bob2.core.members(group_id).unwrap();
    assert_eq!(members.len(), 4);
    let bob_account = bob.account_id();
    assert_eq!(
        members.iter().filter(|m| m.account_id == bob_account).count(),
        2
    );
    assert!(members.iter().any(|m| m.name == "alice-laptop"));

    // Bob-2 removes Bob-1.
    let removal = bob2
        .core
        .remove_members(group_id, &[bob1.device_id.clone()])
        .unwrap();
    assert_eq!(bob2.core.current_epoch(group_id).unwrap(), 3);

    for device in [&alice1, &alice2] {
        let p = device.core.process_incoming(group_id, &removal.commit).unwrap();
        assert_eq!(p.kind.as_str(), "commit");
        assert_eq!(p.epoch, 3);
    }
    // Bob-1 learns it was removed.
    let removed = bob1.core.process_incoming(group_id, &removal.commit).unwrap();
    assert_eq!(removed.kind.as_str(), "commit");

    assert_eq!(bob2.core.members(group_id).unwrap().len(), 3);

    // Epoch 3 messages are unreadable for the removed member.
    let msg4 = alice1.core.encrypt(group_id, b"post-removal").unwrap();
    assert!(bob1.core.process_incoming(group_id, &msg4.ciphertext).is_err());
    let ok = bob2.core.process_incoming(group_id, &msg4.ciphertext).unwrap();
    assert_eq!(ok.plaintext.as_deref(), Some(b"post-removal".as_slice()));
    alice2.core.process_incoming(group_id, &msg4.ciphertext).unwrap();

    // Snapshot persistence: reload Alice-1's state into a brand-new device
    // (fresh storage) and continue encrypting/decrypting.
    //
    // Crash-consistency rule (documented, not tested): reloading an OLD
    // snapshot and then encrypting reuses ratchet positions; receivers will
    // reject the replayed generation, so snapshots must be persisted before
    // ciphertext is released.
    let alice1_reloaded = CoreDevice::create(&alice1.credential, &alice1.secret).unwrap();
    alice1_reloaded.load_group(group_id, &msg4.snapshot).unwrap();
    assert_eq!(alice1_reloaded.current_epoch(group_id).unwrap(), 3);

    let msg5 = alice1_reloaded.encrypt(group_id, b"after reload").unwrap();
    let got = alice2.core.process_incoming(group_id, &msg5.ciphertext).unwrap();
    assert_eq!(got.plaintext.as_deref(), Some(b"after reload".as_slice()));

    // The reloaded device can still decrypt traffic from others.
    let msg6 = bob2.core.encrypt(group_id, b"to reloaded alice").unwrap();
    let got = alice1_reloaded
        .process_incoming(group_id, &msg6.ciphertext)
        .unwrap();
    assert_eq!(got.plaintext.as_deref(), Some(b"to reloaded alice".as_slice()));
}

/// Cross-check vector for `deriveStorageRoot` in @gathernet/mls-client tests:
/// hex of derive_storage_root(PHRASE_A).
const STORAGE_ROOT_VECTOR_A: &str =
    "652fd378df74398c8270228badf21255994a026410550e29e1a114dc180dded6";

#[test]
fn storage_root_derivation_and_domain_separation() {
    let root = derive_storage_root(PHRASE_A).unwrap();
    assert_eq!(root.len(), 32);
    assert_eq!(root, derive_storage_root(PHRASE_A).unwrap());
    assert_ne!(root, derive_storage_root(PHRASE_B).unwrap());
    assert!(derive_storage_root("not a valid mnemonic").is_err());

    // TS cross-check vector (printed so it can be regenerated if needed).
    println!("storage root (PHRASE_A) = {}", hex::encode(root));
    assert_eq!(hex::encode(root), STORAGE_ROOT_VECTOR_A);

    // Domain separation from the identity derivation. First pin the identity
    // path's parameters, then replicate it independently: the replicated seed
    // must (a) yield exactly IdentityKeypair::from_mnemonic's public key and
    // (b) differ from the storage root.
    assert_eq!(IDENTITY_HKDF_SALT, b"gathernet".as_slice());
    assert_eq!(IDENTITY_HKDF_INFO, b"gathernet/v1/identity/ed25519".as_slice());
    let seed = bip39::Mnemonic::parse(PHRASE_A).unwrap().to_seed("");
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(IDENTITY_HKDF_SALT), &seed);
    let mut identity_seed = [0u8; 32];
    hk.expand(IDENTITY_HKDF_INFO, &mut identity_seed).unwrap();
    assert_ne!(identity_seed, root);

    let identity_pk = ed25519_dalek::SigningKey::from_bytes(&identity_seed)
        .verifying_key()
        .to_bytes();
    assert_eq!(
        identity_pk.to_vec(),
        IdentityKeypair::from_mnemonic(PHRASE_A).unwrap().public_key()
    );
}

#[test]
fn exporter_secrets_agree_per_epoch_and_diverge_across_epochs() {
    let alice = IdentityKeypair::from_mnemonic(PHRASE_A).unwrap();
    let a1 = make_device(&alice, "a1");
    let a2 = make_device(&alice, "a2");
    let a3 = make_device(&alice, "a3");
    let group_id = b"exporter-test-group";

    a1.core.create_group(group_id).unwrap();
    let kp2 = a2.core.generate_key_package(false).unwrap();
    let add = a1.core.add_members(group_id, &[kp2.message]).unwrap();
    a2.core.join_from_welcome(&add.welcomes[0]).unwrap();
    assert_eq!(a1.core.current_epoch(group_id).unwrap(), 1);

    // Same epoch, same (label, context, len): both members derive equal bytes.
    let s1 = a1.core.export_secret(group_id, "gathernet/test", b"ctx", 32).unwrap();
    let s2 = a2.core.export_secret(group_id, "gathernet/test", b"ctx", 32).unwrap();
    assert_eq!(s1.len(), 32);
    assert_eq!(s1, s2);

    // Non-mutating: epoch unchanged, re-derivation still matches.
    assert_eq!(a1.core.current_epoch(group_id).unwrap(), 1);
    assert_eq!(
        a1.core.export_secret(group_id, "gathernet/test", b"ctx", 32).unwrap(),
        s1
    );

    // Different label / context diverge; other lengths work.
    assert_ne!(
        a1.core.export_secret(group_id, "gathernet/other", b"ctx", 32).unwrap(),
        s1
    );
    assert_ne!(
        a1.core.export_secret(group_id, "gathernet/test", b"other", 32).unwrap(),
        s1
    );
    assert_eq!(
        a1.core.export_secret(group_id, "gathernet/test", b"ctx", 64).unwrap().len(),
        64
    );

    // After a commit (epoch change) the exported secret differs.
    let kp3 = a3.core.generate_key_package(false).unwrap();
    let add2 = a1.core.add_members(group_id, &[kp3.message]).unwrap();
    let p = a2.core.process_incoming(group_id, &add2.commit).unwrap();
    assert_eq!(p.epoch, 2);
    let s1_e2 = a1.core.export_secret(group_id, "gathernet/test", b"ctx", 32).unwrap();
    let s2_e2 = a2.core.export_secret(group_id, "gathernet/test", b"ctx", 32).unwrap();
    assert_eq!(s1_e2, s2_e2);
    assert_ne!(s1_e2, s1);
}

#[test]
fn epoch0_group_info_supports_external_join() {
    let alice = IdentityKeypair::from_mnemonic(PHRASE_A).unwrap();
    let d1 = make_device(&alice, "d1");
    let d2 = make_device(&alice, "d2");
    let group_id = b"epoch0-external-join";

    // GroupInfo allowing external commit right after create_group: epoch 0,
    // no members added yet.
    d1.core.create_group(group_id).unwrap();
    assert_eq!(d1.core.current_epoch(group_id).unwrap(), 0);
    let info = d1.core.current_group_info(group_id).unwrap();
    assert!(!info.is_empty());

    // A second device external-joins from the epoch-0 GroupInfo (0-RTT).
    let ext = d2.core.external_join(&info).unwrap();
    assert_eq!(ext.group_id, group_id);
    assert_eq!(ext.epoch, 1);

    let p = d1.core.process_incoming(group_id, &ext.commit).unwrap();
    assert_eq!(p.kind.as_str(), "commit");
    assert_eq!(p.epoch, 1);

    // Both directions can message afterwards.
    let m = d2.core.encrypt(group_id, b"external hello").unwrap();
    let got = d1.core.process_incoming(group_id, &m.ciphertext).unwrap();
    assert_eq!(got.plaintext.as_deref(), Some(b"external hello".as_slice()));
    let m2 = d1.core.encrypt(group_id, b"welcome").unwrap();
    let got2 = d2.core.process_incoming(group_id, &m2.ciphertext).unwrap();
    assert_eq!(got2.plaintext.as_deref(), Some(b"welcome".as_slice()));
}
