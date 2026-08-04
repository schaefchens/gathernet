import { describe, expect, it } from 'vitest'
import {
  type ClockEvent,
  DEFAULT_REMIND_OFFSET_MIN,
  isDue,
  reminderInstantOf,
} from './reminder-clock.ts'

const NOON = 1_700_000_000_000
const min = (n: number) => n * 60_000

function ev(startsAt: number, remindOffsetMin?: number): ClockEvent {
  const e: ClockEvent = { communityId: 'cm_x', channelId: 'ch_x', artifactId: 'a1', startsAt }
  if (remindOffsetMin !== undefined) e.remindOffsetMin = remindOffsetMin
  return e
}

describe('reminderInstantOf', () => {
  it('subtracts the event offset', () => {
    expect(reminderInstantOf(ev(NOON, 30))).toBe(NOON - min(30))
  })
  it('falls back to the default offset when none is set', () => {
    expect(reminderInstantOf(ev(NOON))).toBe(NOON - min(DEFAULT_REMIND_OFFSET_MIN))
  })
})

describe('isDue (due mode)', () => {
  // Event at NOON, 60-min reminder → instant R = NOON - 60m.
  const e = ev(NOON, 60)
  const R = NOON - min(60)

  it('fires exactly at the instant', () => {
    expect(isDue(e, R, 'due')).toBe(true)
  })
  it('fires within the past grace (late but deliverable)', () => {
    expect(isDue(e, R + min(14), 'due')).toBe(true)
  })
  it('does not fire before the instant', () => {
    expect(isDue(e, R - min(1), 'due')).toBe(false)
  })
  it('does not fire once the grace has passed (too late → server would reject)', () => {
    expect(isDue(e, R + min(16), 'due')).toBe(false)
  })
})

describe('isDue (early mode)', () => {
  const e = ev(NOON, 60)
  const R = NOON - min(60)

  it('fires when the instant is imminent (going offline soon before)', () => {
    expect(isDue(e, R - min(10), 'early')).toBe(true)
  })
  it('does not early-fire when the instant is still far off', () => {
    expect(isDue(e, R - min(20), 'early')).toBe(false)
  })
  it('does not early-fire once the instant has passed (that is the due path)', () => {
    expect(isDue(e, R + min(1), 'early')).toBe(false)
  })
})
