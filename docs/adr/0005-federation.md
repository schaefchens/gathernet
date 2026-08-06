# ADR 0005: Federation — homed objects, visiting guests, curated discovery

## Status

**DRAFT — not final, not accepted, nothing implemented.**

This records a design conversation (2026-08-06) so the reasoning survives the
feature phase. It is deliberately decision-level: no schemas, no endpoints, no
migrations. **Revisit this document against what has actually been built before
turning any of it into code** — several sections lean on primitives (capabilities,
the no-roster model, channel key epochs) whose enforcement is still on the
crypto-phase pickup list in ADR 0004, and the shape of those may change.

Hard dependency: **ADR 0004 enforcement should land before federation opens.**
Today "the server asserts membership" is tolerable because we run the one server.
The moment users join communities hosted by strangers, that same boundary means
"a stranger's server asserts membership". Identity-signed capabilities are what
make federating safe rather than merely possible.

## Context

Gathernet is a single-server system today: one Fastify node relays ciphertext,
sequences MLS commits, stores blobs, and pushes notifications. The goal is to let
people **host their own Gathernet** — open or closed — and have those servers
connect, so users are not confined to one operator's bubble.

Three properties of the existing system make this unusually tractable:

- **Identity is a key, not an address.** BIP39 → Ed25519 identity → DeviceCerts
  (ADR 0001). There is no `@user:server` namespace to federate and no home server
  baked into an account ID. Federation needs *routing hints*, not naming.
- **The server is already near-zero-trust.** It relays ciphertext and orders it.
  ADR 0002/0003 keep metadata and content keys away from it; ADR 0004 is removing
  the last thing it was trusted for (membership and roles).
- **Trust is already pinned out-of-band.** Invite fragments carry `K_meta`, the key
  epoch, and `ownerAccountId`; clients TOFU-pin the community root. Adding a home
  origin to that fragment is a one-field change and *is* the routing layer.

The threat model is unchanged (ADR 0002/0003/0004): servers are honest-but-curious
and may be compromised or coerced; users may be persecuted Christians for whom a
metadata leak is catastrophic.

The comparison that frames the whole design: **Matrix federates state.** Every
server participating in a room replicates room membership and the event DAG, so
federation *multiplies* metadata exposure — the more servers in a room, the more
parties learn who is in it and who is active. We federate **transport only**.

## Decision (proposed)

### 1. Everything is homed — no cross-server agreement on state, ever

Every group, community, channel, DM, and publication has exactly **one** home
server, named in its signed root and pinned by clients the way the community root
already is. Servers do not share their data; they relay ciphertext on behalf of
their own users.

Rationale: the server owns exactly one authoritative thing — **ordering**. The MLS
commit CAS (`UPDATE groups SET current_epoch = current_epoch + 1 WHERE
current_epoch = $epoch`) and the group_key channel `seq` are single-writer by
construction. Two servers cannot both sequence a group. Homing sidesteps this
entirely: no state resolution, no event DAG, no consensus.

Accepted cost: **if a community's host goes down, that community goes quiet, and
if it is lost, its history is lost.** (Softened by mirroring — §5.)

### 2. Client talks only to its home server; the home server proxies

Two options were considered:

- **Client multi-homing** — the client connects directly to each server hosting a
  community it belongs to. No S2S protocol at all; cheapest thing that works.
- **Home-server proxying** — the client only ever talks to its own server, which
  relays to peers.

**Chosen: proxying.** Under multi-homing, every community you join learns your IP,
your online pattern, and a correlatable device identity. For the users in the
threat model that is disqualifying. Proxying makes the home server a privacy
proxy: the host sees "some account reachable via server B" and nothing more.
Offline queueing and Web Push also fall out naturally instead of requiring a
mailbox at every remote server.

The S2S surface stays small and is ciphertext-in / ciphertext-out throughout —
roughly: post-commit (CAS + result), post-message, pull-since-seq, fetch
GroupInfo / key packages, relay key grants + epoch commitments, fetch media blob,
relay push wake. Envelopes must be strictly additive and version-negotiated from
day one, because peers will run different migrations.

Additional hardening to design in from the start: **per-(group, device) delivery
pseudonyms**, so a host cannot correlate the same visitor across the communities
it hosts. Same pattern as the per-(app, account) `appUserId` in M2.

### 3. Visitors are capability-bearing guests, not accounts

A user homed on A who joins a community on B gets **no account on B**. B creates no
user row, no profile, no credential. It stores a pseudonym, a route ("reachable via
A"), and whatever signed capability that pseudonym presented.

> **A user's rights on a foreign server are exactly what a capability signed by that
> community's own trust root grants, and nothing else. There is no ambient
> permission on a foreign server.**

This only works because ADR 0004 moved authorization off the server: B does not
*decide* membership, it *verifies* an owner/leader-signed cap chain and enforces it.

**A visitor can:** join a community they hold an invite for; read and post within
their caps; fetch key grants and epoch commitments for those channels; fetch that
community's encrypted media; act as a leader if they hold a leader cap.

**A visitor can never:** create an account; enumerate accounts, devices,
communities, or channels; search anything; see presence of non-contacts; see a
roster (already the rule at scale — federation makes it absolute); touch any object
they hold no cap for; consume unmetered resources.

**And B cannot:** assert membership (caps); read plaintext (`K_meta` /
`K_channel`); learn the visitor's IP (proxying); correlate the visitor across the
communities B hosts (pseudonyms).

**Cross-server join walkthrough** — every step uses primitives that already exist;
federation only changes the transport:

1. Client on A opens an invite carrying the community code, `K_meta` epoch + key,
   `ownerAccountId`, and the home origin B.
2. A opens an S2S session to B, presents the code, receives GroupInfo, the epoch
   commitment, and the public root.
3. The client verifies the root against the `ownerAccountId` it got **out of band**
   — so B cannot lie about who owns its own community.
4. A leader's device (homed anywhere) issues the capability + `K_meta` grant,
   relayed B → A → client.

Failure asymmetry worth stating to users: **losing your home server costs you a
mailbox. Losing a community's host costs that community.** Identity, keys,
memberships, and caps survive both — re-home, publish a new route record, carry on.

### 4. Server postures — ingress and egress are separate dials

"Open vs private" is really two independent dials. Four presets:

| Posture | Ingress (others reach communities here) | Egress (my users join elsewhere) | Who it is for |
|---|---|---|---|
| `isolated` | ✗ | ✗ | The closed community that wants no outside contact at all. Fully functional, entirely alone. |
| `outbound` | ✗ | ✓ | **Underground church.** Members join the wider body; nothing here is reachable or even visible from outside. |
| `peered` | allowlist | allowlist | A regional network of servers that know each other. |
| `open` | ✓ | ✓ | Public node taking all comers. |

`outbound` is the posture the threat model most needs and it exists *only* because
the dials are separate: a congregation can host its own server, keep it invisible
(no published server profile, no peer gossip, onion-only), and still participate in
communities hosted by safer servers abroad. Under a state-federating design this is
impossible — joining a room announces your server's existence and its participants.

Rules:

- **`isolated` is a first-class mode, not a degraded config.** Communities,
  channels, DMs, and apps all work. It must be a tested deployment target.
- **Effective policy = server posture ∧ community policy; most restrictive wins.**
  An open server may host a private unlisted community.
- **Opening up is not reversible.** Going private later does not un-publish what
  was published. The transition needs a plain warning, not a toggle that implies
  retroactive privacy.

### 5. Mirroring — durability *and* the cost model

Opt-in: a home server keeps a **read-only ciphertext replica** of groups its users
belong to. It never sequences and never asserts order — the host's `seq` stays
authoritative; the mirror only retains what already passed through it. It leaks
nothing new, because under proxying the home server already sees which remote
groups its users talk to.

This turns out to be the answer to "who pays for visitors":

- Without mirroring a host pays **O(members)** — every member's pulls hit the host.
- With mirroring the host ships **one replication stream per peer server** and each
  visitor pulls from their own home server: **O(peer servers)**. 200 streams
  instead of 10k readers, and the read load lands on the party that should carry
  it.

Consequences that follow:

- **Quotas are per peer server, not per user** — the only unit a host can actually
  see, and enforceable: a misbehaving peer is throttled or de-peered, and that
  peer's admin has a direct incentive to police their own users. Servers regulate
  servers; nobody regulates strangers.
- **No money in the protocol.** No credits, payments, or settlement — a linkability
  hazard, a rabbit hole, and culturally wrong for the intended users. Cost sharing
  is social; the protocol only provides levers: max peers, max mirrored bytes per
  peer, per-channel `messageTtlDays` (already the primary storage bound), media
  size and retention caps.
- **Media is the real cost, not text.** Nudge-and-pull text (M2 Stage 6 fan-out) is
  nearly free; encrypted blobs are not. Mirrors serve media to their own users, and
  media should get a shorter default TTL than messages.

Side effect: once mirroring exists for cost reasons, "host dies, data lost" stops
being strictly true. A leader can re-home from their own server's mirror with a
signed root update — same root, same members, same caps. Possible only because a
server holds ciphertext and ordering rather than meaning.

Practical note: an onion-only server is bandwidth-bound by Tor long before anything
else. Fine for the small private cases; a public regional node wants a clearnet
address with an onion alongside (see `docs/onion.md`).

### 6. Discovery — three invariants

1. **Servers are discoverable.** A node publishes a signed profile: name, language
   / region, peering policy, clearnet + `.onion` addresses, peer list. Low
   sensitivity. (`isolated` / `outbound` nodes publish nothing.)
2. **Communities are discoverable only by opting in**, and opting in means
   publishing a **separate public face** (§7) — never a projection of private
   state.
3. **People are never discoverable.** No user search, no profile lookup, no
   contact discovery, no presence to non-contacts, on any server, ever. This is the
   line that makes the platform's claim true.

**Routing follows the same shape: federate server addresses, never user
directories.** An `accountId → home server` map is a location and social-graph
oracle; it is never gossiped and never queryable. Account routes travel only inside
artifacts the recipient already holds — invite fragments, friend-add payloads, and
self-signed, monotonically versioned **route records** (device-signed, cert-chained
like receipt keys and caps) pushed to people who already know you. The same records
give account portability: publish route record v2 and your contacts follow you to a
new home server.

### 7. Public listing — "shared communication, not data"

A listed community publishes a **public face**: an owner-device-signed,
cert-chained artifact containing display name, description, avatar, language /
region, tags, join policy, invite entry point, and a **bucketed** member count
(never exact — an exact count is an intelligence signal). It contains nothing
derived from `K_meta`: no member list, no activity statistics, no message volume.
It is a separate authored act, not a projection. That separation is what keeps the
slogan honest.

- **Listing defaults to request-to-join.** The existing channel
  `joinPolicy: open|request` lifts to the community's public face, with `request`
  the default when listing. Discoverable-but-gated is the local-church case: a
  regional network can find you; leaders still vet who walks in. Open-join is a
  second, deliberate step.
- **Cryptographic privacy ≠ social privacy, and the UI must say so.** A listed
  open-join community is still perfectly E2EE — the server sees nothing — but
  *anyone can be inside*. That gap is where people actually get hurt. Listed
  communities are visibly marked as public, and **existing members are notified
  when a community becomes listed**, with an easy exit: indexing a previously
  obscure community materially changes every member's exposure and must not happen
  silently.
- **The catalog is federated and curated, never global.** Each host serves its own
  catalog; peers pull and cache; a user browses the union of what their server's
  peers publish. Listings are root-signed, so an aggregator can omit but never
  forge. There is **no global index to scrape, pressure, or subpoena**, and
  moderation becomes "which servers do you peer with", decided per admin for their
  own users.

Existing channel `visibility: listed|unlisted` composes for free: a listed
community with a public welcome channel and private inner channels needs only the
public face on top of current primitives.

### 8. Introductions, not directories

The mechanism for reaching people in other bubbles is **vouching**, not search —
which is how these networks work offline anyway.

- A member privately shares a community (link + `K_meta` + owner root); already
  works, federation only makes the origin cross-server.
- A leader can sign a **sibling-communities list** into the community's E2EE
  metadata — "these are known to us" — so trust propagates along vetted paths
  rather than through a crawlable index.
- Individuals exchange **private attestations**: account X signs "I know account Y
  as `<petname>`", shared only with friends. Cross-bubble identity confidence
  without ever materialising a public social graph.

Public listing is the opt-in on-ramp for communities that genuinely want to be
public; vouching stays the default growth path for everything else.

## Consequences

- **Federation without state replication is federation without metadata
  multiplication.** Only a community's host sees that community's (pseudonymous)
  traffic pattern; no other server learns its membership or graph. This is the
  central competitive claim against Matrix, and it is bought by §1.
- Self-hosting becomes real: identity is a key, so a home server is a mailbox and a
  proxy, not an owner. Combined with onion transport, a box at home with no public
  IP and no domain is a viable Gathernet.
- Residual exposure, stated honestly: a community's host still sees the activity
  pattern of that community — pseudonymous senders, timing, volume. Mitigated by
  per-group pseudonyms, proxying, and onion transport; batching / padding is future
  work. The ADR 0003 guidance stands: **sensitive content belongs in small MLS
  channels.**
- Availability regresses per-community (single host) in exchange for eliminating
  consensus. Mirroring plus signed re-homing is the recovery path.
- New operational surface: peer authentication (server keys, TOFU-pinned), per-peer
  quotas and backpressure, protocol version negotiation, cross-server media fetch,
  and push relay.

## Open questions / not decided

- **Relay routing through peers** — the original "share routes" idea may also mean
  message hopping A → B → C so NAT'd or private nodes stay reachable and metadata
  gets mixed. Bigger design, composes with onion, deliberately out of scope here.
- **Can a user have no home server at all** — pure client using someone else's node
  purely as a mailbox? Strongest privacy story, hardest offline-delivery story.
- **DM homing.** A DM group needs one sequencer; presumably the creating device's
  home server. Means a friend's dead server costs shared history (mirroring
  recovers it). Not settled.
- **Publications / apps across servers.** Homed like everything else, with `gna.`
  tokens issued by the publication's host — but the client reaching an app backend
  directly would break the proxying property. Probably proxied too; unexamined.
- **Posture changes and mid-life re-homing** of an existing community — mechanics,
  UX, and what members are told.
- **Abuse at the listing layer** — spam communities and scraping of public faces;
  mitigated structurally by curated catalogs, but no concrete policy yet.
- **Sequencing hand-off during re-home** — how a mirror proves it holds the
  complete log up to `seq` N, and what happens to in-flight commits.

## Sequencing

1. Finish ADR 0004 enforcement (the crypto-phase pickup list) — hard prerequisite.
2. Promote this draft to a real ADR after re-reading it against the then-current
   code.
3. Thin vertical slice: two dev servers, one community hosted on A, one member
   homed on B — prove commit sequencing, mailbox relay, and cap verification end to
   end before anything else. Communities are the right first surface; DMs and
   publications follow the same homing rule.
