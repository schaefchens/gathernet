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
  accountA: text('account_a')
    .notNull()
    .references(() => accounts.accountId),
  accountB: text('account_b')
    .notNull()
    .references(() => accounts.accountId),
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
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.deviceId),
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
    recipientDevice: text('recipient_device')
      .notNull()
      .references(() => devices.deviceId),
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
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.deviceId),
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

export const communities = pgTable('communities', {
  /** 'cm_' + hex(8 random bytes) */
  communityId: text('community_id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),
  ownerAccountId: text('owner_account_id')
    .notNull()
    .references(() => accounts.accountId),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

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

/** channelId == the MLS groupId (groups.kind = 'channel'). */
export const communityChannels = pgTable(
  'community_channels',
  {
    channelId: text('channel_id')
      .primaryKey()
      .references(() => groups.groupId),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.communityId),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    access: channelAccessEnum('access').notNull().default('members'),
    joinDefault: boolean('join_default').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('community_channels_community_idx').on(t.communityId)],
)

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
