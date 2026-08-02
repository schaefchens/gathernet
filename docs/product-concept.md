# Gathernet Product Concept

## Vision

Gathernet is a privacy-first Christian web platform for shared identity,
friends, chat, presence, apps, games, books, videos, churches, and communities.

It is inspired by the social platform layer of Battle.net and Steam, but not by
their commerce model. Most Gathernet apps and games are expected to be free:
users discover them, open them, install them as PWAs when possible, and use the
same Gathernet account and social graph across them.

Gathernet is web-first. The Hub, games, apps, and community experiences are
Progressive Web Apps. The platform should not depend on mobile or desktop app
stores for distribution, login, chat, presence, or notifications.

## Final Product Rule

Gathernet should be developed directly toward the final architecture. Thin
vertical slices are allowed; throwaway architecture is not.

That means:

- New encrypted messaging work uses the MLS direction from ADR 0001.
- SDK features should be designed around the final app/community model.
- Temporary scaffolding may help local development, but must not become a product
  milestone or public promise.
- When a feature cannot yet be implemented on the final base, it waits instead
  of receiving a separate temporary architecture.

## Product Principles

- Christian by purpose and tone.
- Dark-theme first, with biblical color direction rather than generic gaming
  neon.
- Private by default.
- No email, phone number, or real name required.
- Recovery phrase based account access.
- Friends through private links, codes, or QR flows, not global public search.
- Presence visible to approved friends by default.
- App/game activity can be hidden.
- Chat and group messages are end-to-end encrypted.
- Push notifications avoid sensitive visible content by default.
- Apps receive app-scoped user IDs where practical.
- WebSockets are a core platform primitive, not an optional add-on.

## Main Product Surfaces

### Hub

The Hub is the user's home base.

It provides:

- Account creation and restore.
- Device/session management.
- Local password or passkey unlock for this browser.
- Friend list.
- Friend chat.
- Presence controls.
- Catalog browsing.
- App launch/install flows.
- Notification preferences.
- Community and church spaces.

### Account

Accounts are not based on email, mobile phone, or password reset links.

The account model is closer to a wallet:

1. The browser generates a high-entropy recovery phrase.
2. The user writes it down.
3. The browser derives or protects account/device secrets from that root.
4. The server stores public account/device data, not the recovery phrase.
5. Returning devices use enrolled device keys.
6. New devices can be restored from the recovery phrase.

Real-world implication: a user in a hostile environment can create a pseudonymous
account without giving Gathernet an email or phone database that could later be
leaked, subpoenaed, or abused. The cost is serious: losing the recovery phrase
can mean losing access.

### Friends

Friends are people a user intentionally connects with across Gathernet.

Friend discovery uses private invites:

- Invite link.
- Short code.
- QR code.
- Accept/decline.
- Remove.
- Block.

No global public user search is part of the initial product. (and never will be)

### Presence

Presence shows what a user is doing when they allow it.

Core states:

- Online.
- Away.
- Invisible.
- In app.
- Playing.
- Reading or watching.

Real-world implication: a friend may see "playing Bible Quiz" or "in Prayer
Room" only if the user allows that visibility. Invisible mode should suppress
online and activity visibility.

### Chat

Friend chat is one-to-one from a user's point of view, but cryptographically it
is still a group because each user may have multiple devices.

Production friend chat uses MLS via `mls-rs`, as decided in
[ADR 0001](adr/0001-mls-rs-for-production-e2ee.md).

Real-world implication: if Sarah and John chat, Sarah's phone, Sarah's laptop,
and John's desktop are all MLS clients in the same friend-chat group. If Sarah
loses her phone, the group moves to a new MLS epoch excluding that phone. The
lost phone may still have old local messages, but should not decrypt future
messages.

### App And Game Rooms

Games and apps need scoped group spaces:

- Parties.
- Lobbies.
- Match rooms.
- Temporary group chat.
- App-specific invites.

Each room belongs to exactly one app namespace. An app must not create or manage
rooms outside its own scope.

Production app/game rooms use MLS groups. Developers call simple SDK methods
such as "create party", "invite player", "remove player", and "send room
message"; they should not need to understand MLS internals.

### Persistent Communities

Gathernet supports long-lived groups for:

- Churches.
- Ministries.
- Small groups.
- Classes.
- Teams.
- Local communities.

These are different from game rooms. They may last months or years, have roles,
need moderation, and contain sensitive membership metadata.

Production community chat also uses MLS. Large communities should likely use
multiple MLS-backed channels rather than one enormous all-hands group.

Real-world implication: a church can have a private leaders channel and a
separate members channel. If someone leaves leadership but remains in the
church, only the leaders channel needs a new MLS epoch.

### Catalog

The catalog is a launcher/store-like surface, but not primarily a sales
marketplace.

It should show:

- Apps.
- Games.
- Launch URLs.
- PWA install hints.
- Friend activity when allowed.
- Books, videos, collections, and community recommendations.

## Product Boundaries

Gathernet is not:

- A paid app store.
- A public social network.
- A native launcher.
- A public user directory.
- A federation protocol.
- A fully anonymous metadata-hiding network.
- A moderation-free encrypted space.

Those boundaries matter. The first product should be understandable, private,
and useful before it becomes broad.
