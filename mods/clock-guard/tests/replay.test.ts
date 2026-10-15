import { test, mock, expect } from 'claude-code/testing'

const HOUR = 60 * 60 * 1000

// Test by Ray and Starling. A stand-in clock submits the same firing twice, then the next day's.
// Only the copy should be dropped. With the guard turned off, this test fails: the replay gets through.
// The inline clock has to be self-contained, and test hooks sit beneath plugins, so `arrived` only sees
// what the guard let through.

const replayingClock = {
  name: 'clock',
  register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({ name: 'replay', description: 'test' }); return next(e) })
    on('command.run', { command: 'replay' }, async $ => {
      const wake = '[clock wake: solo] Live time 2026-10-13 05:02 Europe/Rome (scheduled).\nCARRY: Room opened\n\nMorning.'
      $.clock.after(10, () => { void $.prompt.submit({ text: wake }) })
      $.clock.after(20, () => { void $.prompt.submit({ text: wake }) })
      $.clock.after(30, () => { void $.prompt.submit({ text: wake.replace('2026-10-13', '2026-10-14') }) })
      return { text: 'queued' }
    })
  },
}

test('clock wake: a replayed copy is dropped, a new firing goes through', { plugins: [replayingClock] }, async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  const store = new Map()
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  const arrived = []
  on('prompt.submit', async ($, e) => { arrived.push(e.text.split('\n', 1)[0]); return { text: e.text } })
  await $.command.run({ command: 'replay', args: '' })
  await clock.advance(100)
  expect(arrived).toEqual([
    '[clock wake: solo] Live time 2026-10-13 05:02 Europe/Rome (scheduled).',
    '[clock wake: solo] Live time 2026-10-14 05:02 Europe/Rome (scheduled).',
  ])
})
