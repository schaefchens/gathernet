/**
 * Event-reminder clock (peer-triggering). The server can't read the E2EE event time, so
 * member clients are the clock: while online, we watch loaded events and — at each event's
 * reminder instant — POST a real-time trigger. The server relays a content-free push to
 * OFFLINE RSVP'd members and never learns a future time (see modules/push + communities).
 *
 * Trust tiering is enforced server-side: a regular member's trigger 409s while a
 * leader/moderator is online, so we simply leave it for the next sweep to retry — a
 * manager's own clock fires it first, or the manager goes offline and ours goes through.
 *
 * Coverage is best-effort: the due sweep fires at/just-after the instant while online, and
 * `sweepEarly` fires imminent reminders when the tab is about to go away. A fully-dark
 * channel may get no reminder — accepted, to keep the server blind to timing.
 */

import { useEffect } from 'react'
import { useChannelArtifacts } from '../stores/channel-artifacts.ts'
import { ApiError, api, apiKeepalive } from './api.ts'

export type ReminderMode = 'due' | 'early'

export interface ClockEvent {
  communityId: string
  channelId: string
  artifactId: string
  startsAt: number
  remindOffsetMin?: number
}

/** Default lead time when an event doesn't carry one (all clients agree → deterministic). */
export const DEFAULT_REMIND_OFFSET_MIN = 60
/** How late a due reminder may still fire (matches the server's accept grace). */
const PAST_GRACE_MS = 15 * 60_000
/** How far ahead of the instant `sweepEarly` will fire on the way offline. */
const CLIENT_EARLY_MS = 15 * 60_000
const SWEEP_MS = 30_000

/** The reminder instant for an event — deterministic, so every client computes the same
 *  value (→ the same server dedup key). */
export function reminderInstantOf(e: ClockEvent): number {
  return e.startsAt - (e.remindOffsetMin ?? DEFAULT_REMIND_OFFSET_MIN) * 60_000
}

/** Whether an event's reminder should fire now, in the given mode. */
export function isDue(e: ClockEvent, now: number, mode: ReminderMode): boolean {
  const r = reminderInstantOf(e)
  if (mode === 'due') return now >= r && now - r <= PAST_GRACE_MS
  // early: the instant is soon and we're going offline — fire slightly early (best-effort).
  return r > now && r - now <= CLIENT_EARLY_MS
}

/** Flatten loaded channel artifacts into the events the clock tracks. */
function collectEvents(): ClockEvent[] {
  const { byChannel, community } = useChannelArtifacts.getState()
  const out: ClockEvent[] = []
  for (const [channelId, arts] of Object.entries(byChannel)) {
    const communityId = community[channelId]
    if (!communityId) continue
    for (const a of arts) {
      if (a.body.kind !== 'event') continue
      const e: ClockEvent = {
        communityId,
        channelId,
        artifactId: a.artifact.artifactId,
        startsAt: a.body.startsAt,
      }
      if (a.body.remindOffsetMin !== undefined) e.remindOffsetMin = a.body.remindOffsetMin
      out.push(e)
    }
  }
  return out
}

function triggerUrl(e: ClockEvent): string {
  return `/api/v1/communities/${e.communityId}/channels/${e.channelId}/artifacts/${e.artifactId}/reminder-trigger`
}

// Client-side dedup: keys we've already resolved this session, so a sweep doesn't re-POST.
const resolved = new Set<string>()
const keyOf = (e: ClockEvent, r: number) => `${e.channelId}:${e.artifactId}:${r}`

async function fireDue(e: ClockEvent): Promise<void> {
  const r = reminderInstantOf(e)
  const key = keyOf(e, r)
  if (resolved.has(key)) return
  try {
    await api('POST', triggerUrl(e), { reminderInstant: r })
    resolved.add(key) // fired, or already fired by someone else
  } catch (err) {
    // 409 = a manager is online (they'll fire it) → retry next sweep, don't mark resolved.
    if (err instanceof ApiError && err.status === 409) return
    // 400/403/404 (window passed, not a member, gone) are definitive; stop retrying.
    if (err instanceof ApiError) resolved.add(key)
    // transient/network: leave unresolved so the next sweep retries.
  }
}

function fireEarly(e: ClockEvent): void {
  const r = reminderInstantOf(e)
  const key = keyOf(e, r)
  if (resolved.has(key)) return
  resolved.add(key) // page is going away; best-effort, no response to observe
  apiKeepalive(triggerUrl(e), { reminderInstant: r })
}

async function sweepDue(now = Date.now()): Promise<void> {
  for (const e of collectEvents()) {
    if (isDue(e, now, 'due')) await fireDue(e)
  }
}

function sweepEarly(now = Date.now()): void {
  for (const e of collectEvents()) {
    if (isDue(e, now, 'early')) fireEarly(e)
  }
}

/** Start the clock; returns a stop function. */
export function startReminderClock(): () => void {
  void sweepDue()
  const iv = setInterval(() => void sweepDue(), SWEEP_MS)
  const onHidden = () => {
    if (document.visibilityState === 'hidden') sweepEarly()
  }
  const onPageHide = () => sweepEarly()
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    clearInterval(iv)
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('pagehide', onPageHide)
  }
}

/** Run the reminder clock for the lifetime of the authenticated shell. */
export function useReminderClock(): void {
  useEffect(() => startReminderClock(), [])
}
