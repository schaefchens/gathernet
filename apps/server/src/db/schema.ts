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

export const authChallenges = pgTable('auth_challenges', {
  /** the 32 random bytes themselves — single use, deleted on consumption */
  challenge: bytea('challenge').primaryKey(),
  purpose: challengePurposeEnum('purpose').notNull(),
  used: boolean('used').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
