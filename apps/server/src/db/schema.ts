import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const presencePrefEnum = pgEnum('presence_pref', ['online', 'away', 'invisible'])
export const deviceStatusEnum = pgEnum('device_status', ['active', 'revoked'])
export const challengePurposeEnum = pgEnum('challenge_purpose', ['enroll', 'login'])

export const accounts = pgTable('accounts', {
  /** base58(accountPk) — self-authenticating */
  accountId: text('account_id').primaryKey(),
  accountPk: bytea('account_pk').notNull().unique(),
  displayName: text('display_name').notNull(),
  presencePref: presencePrefEnum('presence_pref').notNull().default('online'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const devices = pgTable(
  'devices',
  {
    /** hex(first 16 bytes of SHA-256(devicePk)) */
    deviceId: text('device_id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    devicePk: bytea('device_pk').notNull().unique(),
    /** canonical-CBOR DeviceCert as signed by the identity key */
    cert: bytea('cert').notNull(),
    certSig: bytea('cert_sig').notNull(),
    /** persistent ECIES receipt public key (raw SPKI) — community K_meta grants
     *  are sealed to it; authenticated by receiptPkSig under devicePk. Nullable:
     *  devices enrolled before this feature simply can't receive grants. */
    receiptPk: bytea('receipt_pk'),
    /** Ed25519(devicePk, domain.receiptKey || receiptPk) */
    receiptPkSig: bytea('receipt_pk_sig'),
    name: text('name').notNull(),
    status: deviceStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('devices_account_idx').on(t.accountId)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.deviceId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    /** sha256 of the opaque bearer token; the token itself is never stored */
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_device_idx').on(t.deviceId)],
)

export const friendInvites = pgTable(
  'friend_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inviterAccountId: text('inviter_account_id')
      .notNull()
      .references(() => accounts.accountId),
    /** crockford base32, unambiguous-charset, CSPRNG */
    code: text('code').notNull().unique(),
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('friend_invites_inviter_idx').on(t.inviterAccountId)],
)

/** accountA < accountB (lexicographic) — one row per friendship. */
export const friendships = pgTable(
  'friendships',
  {
    accountA: text('account_a')
      .notNull()
      .references(() => accounts.accountId),
    accountB: text('account_b')
      .notNull()
      .references(() => accounts.accountId),
    inviteId: uuid('invite_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountA, t.accountB] }),
    index('friendships_b_idx').on(t.accountB),
  ],
)

export const blocks = pgTable(
  'blocks',
  {
    blockerAccountId: text('blocker_account_id')
      .notNull()
      .references(() => accounts.accountId),
    blockedAccountId: text('blocked_account_id')
      .notNull()
      .references(() => accounts.accountId),
    /** Time-limited by design (no permanent block) — a block is ACTIVE only while
     *  expiresAt > now(); expiry is lazy (filtered at read time, pruned opportunistically). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerAccountId, t.blockedAccountId] })],
)

export const mlsKindEnum = pgEnum('mls_message_kind', ['application', 'commit', 'proposal'])

export const keyPackages = pgTable(
  'key_packages',
  {
    /** hex key-package ref from the MLS client */
    ref: text('ref').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.deviceId),
    data: bytea('data').notNull(),
    isLastResort: boolean('is_last_resort').notNull().default(false),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    consumedBy: text('consumed_by'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('key_packages_device_idx').on(t.deviceId)],
)

export const groups = pgTable('groups', {
  /** hex(16 random bytes) */
  groupId: text('group_id').primaryKey(),
  kind: text('kind').notNull().default('dm'),
  /** dm pair (accountA < accountB); NULL for kind 'room' — membership lives in room_members */
  accountA: text('account_a').references(() => accounts.accountId),
  accountB: text('account_b').references(() => accounts.accountId),
  /** the side whose device must build the MLS group (the invite accepter) */
  creatorAccountId: text('creator_account_id').notNull(),
  /** epoch that the next commit must be built at */
  currentEpoch: integer('current_epoch').notNull().default(0),
  lastSeq: integer('last_seq').notNull().default(0),
  /** latest GroupInfo (with ratchet tree) for external joins */
  groupInfo: bytea('group_info'),
  groupInfoEpoch: integer('group_info_epoch'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.groupId),
    /**
     * Deliberately NOT an FK: dm/channel leaves are `devices` rows, room
     * leaves may be `app_devices` rows. The delivery service validates the
     * owner table per group kind (migration 0004 dropped the original FK to
     * `devices`; the index and composite PK remain).
     */
    deviceId: text('device_id').notNull(),
    accountId: text('account_id').notNull(),
    addedEpoch: integer('added_epoch').notNull(),
    removedEpoch: integer('removed_epoch'),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.deviceId] }),
    index('group_members_device_idx').on(t.deviceId),
  ],
)

export const mlsMessages = pgTable(
  'mls_messages',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.groupId),
    seq: integer('seq').notNull(),
    kind: mlsKindEnum('kind').notNull(),
    epoch: integer('epoch').notNull(),
    senderDevice: text('sender_device').notNull(),
    payload: bytea('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.seq] })],
)

export const welcomes = pgTable(
  'welcomes',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    /**
     * Deliberately NOT an FK: a recipient may be a `devices` row (dm/channel)
     * OR an `app_devices` row (rooms). Migration 0005 dropped the original FK
     * to `devices` — without it, room welcomes to app devices aborted the
     * commit transaction. Index retained.
     */
    recipientDevice: text('recipient_device').notNull(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.groupId),
    payload: bytea('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('welcomes_recipient_idx').on(t.recipientDevice)],
)

/** Per-device cumulative delivery cursor; drives mailbox pruning. */
export const mlsCursors = pgTable(
  'mls_cursors',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.groupId),
    /**
     * Not an FK (see welcomes): room acks come from `app_devices`, not
     * `devices`. Migration 0005 dropped the FK — without it, room chat.ack
     * failed on every ack for app-device members, so their cursors never
     * advanced and room ciphertext was never pruned.
     */
    deviceId: text('device_id').notNull(),
    ackedSeq: integer('acked_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.deviceId] })],
)

/* ============================== M2: publications & app platform ============================== */

export const publicationKindEnum = pgEnum('publication_kind', ['app', 'game', 'book', 'video'])
export const listingStatusEnum = pgEnum('listing_status', ['draft', 'unlisted', 'listed'])
export const grantCodeStatusEnum = pgEnum('grant_code_status', [
  'pending',
  'approved',
  'denied',
  'consumed',
])

/** Everything publishable — apps/games act in M2; book/video are schema-ready. */
export const publications = pgTable('publications', {
  /** 'pub_' + hex(8 random bytes) */
  pubId: text('pub_id').primaryKey(),
  kind: publicationKindEnum('kind').notNull(),
  publisherAccountId: text('publisher_account_id')
    .notNull()
    .references(() => accounts.accountId),
  name: text('name').notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  /** unlisted = usable via link/appId but not in any catalog; 'listed' needs review (M3) */
  listing: listingStatusEnum('listing').notNull().default('unlisted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** kind app|game configuration */
export const appConfigs = pgTable('app_configs', {
  pubId: text('pub_id')
    .primaryKey()
    .references(() => publications.pubId),
  /** exact web origins allowed for CORS + postMessage target validation */
  origins: text('origins').array().notNull(),
  allowedScopes: text('allowed_scopes').array().notNull(),
  /** optional service account whose devices join rooms as the app's server */
  serviceAccountId: text('service_account_id').references(() => accounts.accountId),
})

/** Pseudonym per (app, account) — never deleted so saves survive revoke → re-grant. */
export const appAccounts = pgTable(
  'app_accounts',
  {
    pubId: text('pub_id')
      .notNull()
      .references(() => publications.pubId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    /** 'au_' + hex(16 random bytes) — random, no derivation */
    appUserId: text('app_user_id').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pubId, t.accountId] })],
)

/** Standing consent; deleting the row is revocation (sessions check it on verify). */
export const appGrants = pgTable(
  'app_grants',
  {
    pubId: text('pub_id')
      .notNull()
      .references(() => publications.pubId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pubId, t.accountId] })],
)

export const appSessions = pgTable(
  'app_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pubId: text('pub_id')
      .notNull()
      .references(() => publications.pubId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    scopes: text('scopes').array().notNull(),
    /** sha256 of the `gna.` token secret */
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('app_sessions_account_idx').on(t.accountId, t.pubId)],
)

export const appGrantCodes = pgTable('app_grant_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  pubId: text('pub_id')
    .notNull()
    .references(() => publications.pubId),
  /** 8-char crockford, shown XXXX-XXXX */
  userCode: text('user_code').notNull().unique(),
  /** sha256 of the 32-byte poll secret */
  pollSecretHash: bytea('poll_secret_hash').notNull().unique(),
  requestedScopes: text('requested_scopes').array().notNull(),
  /** raw P-256 SPKI from the SDK, for sealed storage-key handoff */
  appEphemeralPk: bytea('app_ephemeral_pk'),
  status: grantCodeStatusEnum('status').notNull().default('pending'),
  accountId: text('account_id').references(() => accounts.accountId),
  grantedScopes: text('granted_scopes').array(),
  /** AES-GCM(ECDH(hubEph, appEph), perAppStorageKey) — server relays ciphertext only */
  sealedStorageKey: bytea('sealed_storage_key'),
  hubEphemeralPk: bytea('hub_ephemeral_pk'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Client-side sealed blobs; server never sees plaintext or keys. */
export const appStorage = pgTable(
  'app_storage',
  {
    pubId: text('pub_id')
      .notNull()
      .references(() => publications.pubId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    key: text('key').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pubId, t.accountId, t.key] })],
)

/* ============================== M2: rooms ============================== */

/**
 * SDK-registered room devices for app sessions (account-scoped `gna.` tokens
 * have no real device). The SDK generates the Ed25519 keypair itself and
 * builds a SELF-SIGNED DeviceCert-shaped MLS credential: accountPk field ==
 * devicePk, cert signature by the device key. The MLS IdentityProvider (see
 * crates/mls-wasm/src/core/identity.rs) only checks internal consistency —
 * sig verifies under the embedded accountPk and the leaf signature key equals
 * the certified devicePk — so self-signed app-device credentials interoperate
 * with real DeviceCert credentials in the same group with zero crates changes
 * (verified against packages/mls-client). The real credential chain (account
 * identity key signing) is the M3 sub-credential problem; server-side rooms
 * authorization does not rely on the credential, only on room_members rows.
 *
 * deviceId = hex(first 16 bytes of SHA-256(devicePk)) — same rule as devices.
 */
export const appDevices = pgTable(
  'app_devices',
  {
    deviceId: text('device_id').primaryKey(),
    pubId: text('pub_id')
      .notNull()
      .references(() => publications.pubId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    appUserId: text('app_user_id').notNull(),
    devicePk: bytea('device_pk').notNull().unique(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('app_devices_account_idx').on(t.pubId, t.accountId)],
)

export const roomVisibilityEnum = pgEnum('room_visibility', ['public', 'private'])
export const roomPhaseEnum = pgEnum('room_phase', ['open', 'in_progress', 'closed'])
export const roomMemberStatusEnum = pgEnum('room_member_status', ['active', 'left', 'kicked'])
export const joinRequestStatusEnum = pgEnum('join_request_status', [
  'pending',
  'approved',
  'declined',
  'expired',
])

export const rooms = pgTable(
  'rooms',
  {
    /** roomId == the MLS groupId (groups.kind = 'room') */
    roomId: text('room_id')
      .primaryKey()
      .references(() => groups.groupId),
    pubId: text('pub_id')
      .notNull()
      .references(() => publications.pubId),
    /** 4 chars, unambiguous alphabet; unique per app among live rooms */
    code: text('code').notNull(),
    visibility: roomVisibilityEnum('visibility').notNull().default('private'),
    title: text('title').notNull(),
    hostAccountId: text('host_account_id')
      .notNull()
      .references(() => accounts.accountId),
    maxMembers: integer('max_members').notNull().default(16),
    /** opaque app version fingerprint; join requires equality */
    compatTag: text('compat_tag').notNull(),
    phase: roomPhaseEnum('phase').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('rooms_browse_idx').on(t.pubId, t.visibility, t.phase),
    index('rooms_code_idx').on(t.pubId, t.code),
  ],
)

/** Account-level membership (device leaves live in group_members). */
export const roomMembers = pgTable(
  'room_members',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.roomId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    appUserId: text('app_user_id').notNull(),
    isService: boolean('is_service').notNull().default(false),
    status: roomMemberStatusEnum('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.accountId] })],
)

export const roomJoinRequests = pgTable('room_join_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.roomId),
  accountId: text('account_id').notNull(),
  appUserId: text('app_user_id').notNull(),
  status: joinRequestStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

/* ============================== M2: communities ============================== */

export const communityRoleEnum = pgEnum('community_role', ['owner', 'leader', 'member'])
export const communityMemberStatusEnum = pgEnum('community_member_status', [
  'active',
  'left',
  'removed',
])
export const channelAccessEnum = pgEnum('channel_access', ['members', 'leaders'])
export const channelVisibilityEnum = pgEnum('channel_visibility', ['listed', 'unlisted'])
export const channelJoinPolicyEnum = pgEnum('channel_join_policy', ['open', 'request'])
export const channelPostPolicyEnum = pgEnum('channel_post_policy', ['everyone', 'moderators'])
/**
 * How a channel's messages are encrypted. 'mls' = one MLS group (per-message
 * forward secrecy, immediate removal) — the default, best for small/sensitive
 * channels. 'group_key' = a shared per-channel content key K_channel (epoch'd,
 * ECIES-granted per device) — scales to broadcast (100k) / large discussion
 * (10k) channels that MLS cannot. DMs and rooms are always MLS.
 */
export const channelEncryptionModeEnum = pgEnum('channel_encryption_mode', ['mls', 'group_key'])
export const channelMemberStatusEnum = pgEnum('channel_member_status', [
  'active',
  'pending',
  'invited',
  'removed',
])
export const channelMemberRoleEnum = pgEnum('channel_member_role', ['member', 'moderator'])
export const channelInviteKindEnum = pgEnum('channel_invite_kind', ['code', 'targeted'])

export const communities = pgTable('communities', {
  /** 'cm_' + hex(8 random bytes) */
  communityId: text('community_id').primaryKey(),
  /** seal(K_meta, {name, description}) — server never sees plaintext */
  metaCiphertext: bytea('meta_ciphertext'),
  avatarMediaId: text('avatar_media_id'),
  /** current K_meta epoch; bumped on rotation. Grants + a client's held key
   *  are matched to this. */
  keyEpoch: integer('key_epoch').notNull().default(0),
  /** set when a member is removed/leaves; a leader's client then rotates K_meta
   *  (re-encrypts metadata under a new epoch) and clears this. */
  rotationPending: boolean('rotation_pending').notNull().default(false),
  ownerAccountId: text('owner_account_id')
    .notNull()
    .references(() => accounts.accountId),
  /** Owner-device attestation of ownership (capability-chain root): the device that
   *  signed it + Ed25519(ownerDeviceKey, domain.communityRoot ‖ communityId ‖
   *  ownerAccountId). Nullable — communities predating identity-signed capabilities. */
  rootDeviceId: text('root_device_id').references(() => devices.deviceId),
  rootSig: bytea('root_sig'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Per-device K_meta grants: `sealedKMeta` = eciesSeal(device.receiptPk, K_meta),
 * so any device can obtain the community's metadata key without a fresh invite.
 * The server only relays ciphertext — it never sees K_meta.
 */
export const communityKeyGrants = pgTable(
  'community_key_grants',
  {
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    keyEpoch: integer('key_epoch').notNull(),
    granteeDeviceId: text('grantee_device_id')
      .notNull()
      .references(() => devices.deviceId),
    sealedKMeta: bytea('sealed_kmeta').notNull(),
    senderPkB64: text('sender_pk_b64').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.accountId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.communityId, t.keyEpoch, t.granteeDeviceId] }),
    index('community_key_grants_grantee_idx').on(t.granteeDeviceId),
  ],
)

/**
 * Authenticated per-epoch commitment to a community's K_meta (mirror of
 * channel_key_epochs): `keyCommitment` = SHA256(domain ‖ communityId ‖ keyEpoch ‖
 * K_meta), signed by an authorized minter device. A grantee recomputes the
 * commitment from its opened K_meta grant and checks it here — binding the sealed
 * key to this community+epoch so a compromised relay can't feed one community's
 * grant blob as another's (the ECIES seal alone binds only the recipient key).
 * One row per epoch (server-enforced).
 */
export const communityKeyEpochs = pgTable(
  'community_key_epochs',
  {
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    keyEpoch: integer('key_epoch').notNull(),
    keyCommitment: bytea('key_commitment').notNull(),
    minterDeviceId: text('minter_device_id')
      .notNull()
      .references(() => devices.deviceId),
    minterSig: bytea('minter_sig').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.keyEpoch] })],
)

/**
 * Identity-signed membership/role capabilities (server relays ciphertext-of-trust
 * only — it never issues or is trusted for them). `scope` = 'community' or a
 * channelId; `role` = owner|leader|member|moderator. Verified client-side against
 * the pinned owner root. One row per (community, scope, subject, epoch); old epochs
 * pruned with the key grants they ride alongside (revocation = not re-issued).
 */
export const membershipCapabilities = pgTable(
  'membership_capabilities',
  {
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    scope: text('scope').notNull(),
    subjectAccountId: text('subject_account_id')
      .notNull()
      .references(() => accounts.accountId),
    epoch: integer('epoch').notNull(),
    role: text('role').notNull(),
    issuerDeviceId: text('issuer_device_id')
      .notNull()
      .references(() => devices.deviceId),
    issuerSig: bytea('issuer_sig').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.accountId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.communityId, t.scope, t.subjectAccountId, t.epoch] }),
    index('membership_capabilities_subject_idx').on(t.communityId, t.subjectAccountId),
  ],
)

export const communityMembers = pgTable(
  'community_members',
  {
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    role: communityRoleEnum('role').notNull().default('member'),
    status: communityMemberStatusEnum('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.accountId] })],
)

/** channelId == the MLS groupId (groups.kind = 'channel'). Display metadata
 *  (title/emoji/description) is encrypted under the community's K_meta. */
export const communityChannels = pgTable(
  'community_channels',
  {
    channelId: text('channel_id')
      .primaryKey()
      .references(() => groups.groupId),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    /** seal(K_meta, {title, emoji, description}) */
    metaCiphertext: bytea('meta_ciphertext'),
    avatarMediaId: text('avatar_media_id'),
    position: integer('position').notNull().default(0),
    /** who is eligible to join at all */
    access: channelAccessEnum('access').notNull().default('members'),
    /** listed = shown in the directory to eligible members; unlisted = code/invite only */
    visibility: channelVisibilityEnum('visibility').notNull().default('listed'),
    /** open = eligible member self-joins; request = pending until a mod accepts */
    joinPolicy: channelJoinPolicyEnum('join_policy').notNull().default('open'),
    /** everyone = any active member may post; moderators = read-only for non-mods */
    postPolicy: channelPostPolicyEnum('post_policy').notNull().default('everyone'),
    /** disappearing-message window in days (server prunes; clients also prune locally) */
    messageTtlDays: integer('message_ttl_days').notNull().default(30),
    /** mls (default, small/sensitive) vs group_key (scalable). @see channelEncryptionModeEnum */
    encryptionMode: channelEncryptionModeEnum('encryption_mode').notNull().default('mls'),
    /** group_key only: current K_channel epoch (grants + held keys match this). Unused for mls. */
    keyEpoch: integer('key_epoch').notNull().default(0),
    /** group_key only: set when a member is removed/leaves; a manager's client
     *  then mints a new K_channel epoch (re-grants remaining devices) and clears this. */
    rotationPending: boolean('rotation_pending').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('community_channels_community_idx').on(t.communityId)],
)

/** Account-level channel membership (device leaves live in group_members). */
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => communityChannels.channelId),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId),
    status: channelMemberStatusEnum('status').notNull().default('active'),
    role: channelMemberRoleEnum('role').notNull().default('member'),
    /** moderator/leader muted this member — read-only for them in this channel */
    muted: boolean('muted').notNull().default(false),
    invitedBy: text('invited_by'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.accountId] }),
    index('channel_members_account_idx').on(t.accountId),
  ],
)

export const channelInvites = pgTable(
  'channel_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: text('channel_id')
      .notNull()
      .references(() => communityChannels.channelId),
    kind: channelInviteKindEnum('kind').notNull(),
    /** set for kind='code' */
    code: text('code').unique(),
    /** set for kind='targeted' */
    inviteeAccountId: text('invitee_account_id'),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.accountId),
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channel_invites_channel_idx').on(t.channelId)],
)

/**
 * Per-device K_channel grants for group_key channels: `sealedKey` =
 * eciesSeal(device.receiptPk, K_channel[keyEpoch]). Mirrors community_key_grants
 * but channel-scoped and minted only by a bounded granter set (channel
 * moderators / community leaders), lazily as members join. The server relays
 * ciphertext only — it never sees K_channel. The authenticated epoch-key
 * commitment (fork detection) lives in channel_key_epochs.
 */
export const channelKeyGrants = pgTable(
  'channel_key_grants',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => communityChannels.channelId),
    keyEpoch: integer('key_epoch').notNull(),
    granteeDeviceId: text('grantee_device_id')
      .notNull()
      .references(() => devices.deviceId),
    sealedKey: bytea('sealed_key').notNull(),
    senderPkB64: text('sender_pk_b64').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.accountId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.keyEpoch, t.granteeDeviceId] }),
    index('channel_key_grants_grantee_idx').on(t.granteeDeviceId),
  ],
)

/**
 * Authenticated per-epoch commitment to a group_key channel's K_channel:
 * `keyCommitment` = SHA256(domain ‖ channelId ‖ keyEpoch ‖ K_channel), signed by
 * an authorized minter device (`minterSig`). A grantee recomputes the commitment
 * from its opened grant and checks it here — detecting a server or malicious
 * member handing different keys to different members (channel partition). One row
 * per epoch (server-enforced), so no two keys can claim the same epoch.
 */
export const channelKeyEpochs = pgTable(
  'channel_key_epochs',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => communityChannels.channelId),
    keyEpoch: integer('key_epoch').notNull(),
    keyCommitment: bytea('key_commitment').notNull(),
    minterDeviceId: text('minter_device_id')
      .notNull()
      .references(() => devices.deviceId),
    minterSig: bytea('minter_sig').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.keyEpoch] })],
)

/** Encrypted media (community + channel avatars); ciphertext = seal(K_meta, imageBytes). */
export const communityMedia = pgTable('community_media', {
  /** 'md_' + hex(16 random bytes) */
  mediaId: text('media_id').primaryKey(),
  communityId: text('community_id')
    .notNull()
    .references(() => communities.communityId),
  /** ciphertext lives in object storage (BlobStore), keyed by mediaId; this row is
   *  metadata + the membership/community binding used to authorize downloads. */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Encrypted chat message attachments (images/files/voice). Ciphertext ONLY — sealed
 * client-side with a fresh per-file key that lives inside the E2EE message body and
 * never reaches the server; `mediaId` is a high-entropy bearer token that only
 * appears inside those bodies. Not community-scoped (used by DMs + channels alike).
 * (Backing store is Postgres bytea for now — object storage is the production step.)
 */
export const messageMedia = pgTable('message_media', {
  /** 'mm_' + hex(16 random bytes) */
  mediaId: text('media_id').primaryKey(),
  /** ciphertext lives in object storage (BlobStore), keyed by mediaId; this row is
   *  metadata — sizeBytes + uploader (for delete-authorization) + existence. */
  sizeBytes: integer('size_bytes').notNull(),
  uploaderAccountId: text('uploader_account_id')
    .notNull()
    .references(() => accounts.accountId),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const communityInvites = pgTable(
  'community_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    creatorAccountId: text('creator_account_id')
      .notNull()
      .references(() => accounts.accountId),
    code: text('code').notNull().unique(),
    maxUses: integer('max_uses').notNull().default(25),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('community_invites_community_idx').on(t.communityId)],
)

export const authChallenges = pgTable('auth_challenges', {
  /** the 32 random bytes themselves — single use, deleted on consumption */
  challenge: bytea('challenge').primaryKey(),
  purpose: challengePurposeEnum('purpose').notNull(),
  used: boolean('used').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
