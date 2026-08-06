# Gathernet — design brief and implementation status

The visual direction is set by two approved concepts and is now implemented across the
Hub's shell, conversation list, chat surfaces, and community header. This document is
both the brief (direction + rules for new work) and the record of what exists.

- `screenshots/prototype_chat.png` — mobile, community chat
- `screenshots/concept-desktop.png` — desktop, threaded chat with detail panel

**The concepts are graphics, not feature documentation.** Take the visual language and
apply it to Gathernet's actual features; the sample content is set dressing. See
"How to read the concepts" below.

## What Gathernet is

A privacy-first Christian web platform: shared identity, friends, presence, and
end-to-end encrypted chat — the social layer for apps, games, churches, and communities.
Web-first; everything is a PWA. No native app, no app store. The surface being designed
is the Hub: React 19 + Tailwind v4.

## Constraints that shape the design more than taste does

1. **There is no account recovery.** A BIP39 recovery phrase is the only root of identity.
   No email, no phone, no password reset.
2. **The server never sees plaintext.** Chat is MLS (RFC 9420).
3. **No public directory, ever.** Invite link, short code, or QR only. No user search, no
   browsable profiles. Large channels expose no member roster.
4. **Users may be in hostile environments.** Also served over a Tor v3 onion service. No
   off-origin requests: no CDN fonts, no remote images, no analytics, no GIF providers.
5. **Search is client-side only.** The server cannot search ciphertext.
6. **Notifications are content-free by default.**
7. **Christian by purpose and tone**, restrained.

## Visual direction

**Illuminated manuscript, not chat app**: a dark aubergine binding holding a parchment
page. All chrome — rail, sidebar, headers, composer, panels — is near-black violet; the
message canvas is warm parchment with a vine watermark and an inner frame. Light-on-dark
*around* dark-on-light. This is the most distinctive move in the design; keep it.

### Implemented token set (`apps/hub/src/styles/app.css`)

```
chrome        night   #060815   deepest — icon rail, page ground
              raised  #171420   sidebar, header bar
              overlay #171128   card / panel
              edge    #2a2140   hairline border
              selected #1f102d · accent-surface #231534
ink           ink #f0e6d2 · ink-soft #b3a68c · ink-faint #7d7259
gold          gold #c9962f · gold-bright #f8d06f · gold-deep #a1722a
parchment     canvas #e1bb80 · canvas-raised #f2ddb7 · canvas-edge #c9a86a
              canvas-ink #2a2213
jewel         indigo #3b2a63 · plum #4a1d3f · maroon #5c1a24 · olive #4c5320
status        amber #d8a33c · danger #c2564a
```

Two mechanics worth knowing before touching this file:

- **`.parchment` re-declares the palette.** Because Tailwind v4 utilities compile to
  `var(--color-…)` references, the message canvas overrides the ink/surface variables in
  one place and every child flips to dark-on-parchment. Components don't need to know
  which surface they landed on. `.bubble-own` and `.bubble-nested` re-scope ink again so
  cream text stays legible on olive and violet.
- **Don't name a colour token after a font-size utility.** `--color-base` generated a
  `text-base` *colour* that beat Tailwind's `text-base` font-size and rendered text
  near-black. The token is now `night`.

### Type

Cormorant Garamond, self-hosted at `apps/hub/public/fonts/` — variable weight axis
(300–700), subset to latin + latin-ext so German umlauts survive, ~43 KB per file, plus
the italic face. SIL OFL, licence at `/fonts/OFL.txt`. Preloaded in `index.html` and
precached by the service worker, so it works offline and over the onion service. Its
default axis weight is Light: prominent display strings need an explicit
`font-semibold`. Sans is Inter with a `system-ui` fallback (Inter itself is not bundled).

### Rules the concepts establish

- **Gold is the only accent.** Wordmark, hairlines, icon strokes, active states, send button.
- **Heraldry, not clipart.** `.seal` — gold ring, jewel-tone field, serif monogram — is
  the standard: struck seals, not iconography dropped on a page.
- **Serif for identity** (wordmark, community and sender names, nav labels), sans for body
  and metadata. Section labels are small-caps and letterspaced.
- **Trust is surfaced, not hidden**: a chip row on the group header and a persistent
  "Your messages are protected" card in the sidebar.
- **Icons are hand-rolled inline SVG** (`components/icons.tsx`) — an icon package would be
  both an off-origin risk and overkill for a dozen glyphs.

## Shell

Desktop: icon rail (72px) + conversation sidebar (310px) + content pane. Mobile: header +
5-slot bottom tab bar with the elevated gold Connect action. The three are **mounted
conditionally** via `useMediaQuery`, not toggled with `hidden` — otherwise the navigation,
wordmark, presence control, and conversation list all exist twice in the DOM, which
double-queries and breaks any `getByText` selector.

### The conversation list

One list holds **both the communities you're in and the friends you can message**. A
community row opens the community; a person row opens the 1:1 chat. `ChatList` renders it
`compact` in the desktop sidebar and, below `md`, as the `/` Chats screen — one component,
so the two can't drift. Per-person actions (remove, time-limited block) live on the rows.

## How to read the concepts

Do **not** carry over: message auto-delete / "1h timer", "Community safety mode", "Relay
mode", read receipts, sort and mark-all-read, "others will see a summary" thread
visibility, the GIF button (third-party service — forbidden), or the name "Sanctum".

Adapt rather than copy:

- The trust chip row shows only what is true: E2EE, and the exact member count for small
  communities or the coarse size band for large ones.
- Large channels have no roster, and the header must read as intentional, not broken.
- Threading caps at depth 3 plus a separate thread view; the desktop concept draws four.
- Custom window controls assume an installed PWA with window-controls-overlay. The
  standard titlebar is the default case.

## Status

**Built:** the token system and primitives; the desktop rail + sidebar and mobile tab bar;
the unified Chats list; the parchment canvas with vine watermark, ornamented date
dividers, parchment/olive/violet bubbles, jewel-tone monogram avatars and per-sender name
tints; the composer as round icon buttons + pill field + gold send circle; the community
header with seal, serif name and trust chips. Every other screen — onboarding, recovery
phrase, unlock, add-friend, settings, consent, moderation — inherits the token system and
was checked, but none has had a bespoke pass.

**Deliberately not built:**

- **Sidebar search.** The concept shows one; client-side-only search does not exist yet,
  and a dead input is a fake affordance.
- **The desktop thread-detail panel** (the concept's fourth column). Threads still use the
  existing `ThreadView` overlay.
- **The gold connector tree** in the canvas. Nesting still uses the existing indent.

**Still to design — the screens the concepts don't cover, in priority order:**

1. **Onboarding / recovery phrase.** The highest-stakes moment in the product: generate →
   display → write down → confirm. It must slow the user down without patronising them and
   must not encourage screenshots. The manuscript language should peak here; today it only
   inherits the tokens.
2. **Restore from phrase**, **unlock**, and the **app-authorization consent popup** — the
   consent screen must feel unspoofable and make scope consequences legible.
3. **Friend 1:1 chat** as a designed surface (it currently reuses the community treatment),
   and the **zero-friends empty state**, which is the first screen most new users see.
4. **Communities beyond the header**: member panel, pinned bar, invite panel, channel
   settings, moderation queue, and visibly distinct small / large / broadcast channels.
5. **Catalog** — the launcher for apps, games, books, and videos. Absent from both concepts
   and not built. A major reason the platform exists.

## Explicitly do not

- No engagement mechanics: streaks, badges, infinite feeds, unread-count anxiety.
- No churchy stock imagery or cross/dove/scroll clipart.
- No gaming neon or glassmorphism. The glow on the mobile Connect action is the maximum.
- No public profiles, user search, follower graphs, or server-hosted avatar uploads.
- No external fonts, icon fonts, image CDNs, or GIF providers.
- No dark patterns around the recovery phrase.
- No component library, CSS-in-JS, or runtime theming engine. Everything is Tailwind
  utilities plus the primitives in `app.css`.

## The one-sentence test

Every screen should make a pseudonymous user in a hostile environment feel *calmly
protected* — not surveilled, not lectured about security, and not sold to.
