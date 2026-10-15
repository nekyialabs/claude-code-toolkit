import type { Register } from 'claude-code'

// clock-guard: drops a replayed clock wake.
//
// When Claude Code replaces a lost hooks worker, a `$.prompt.submit` made from a timer can be made again with
// the same input, so the same wake arrives twice, minutes apart. A mod's own `prompt.submit` hook doesn't see
// the prompts that mod submits, so the clock can't guard itself; this companion mod does it instead.
//
// The wake header line ("[clock wake: <id>] Live time <date> <time> ...") already names exactly one firing,
// so it works as the key: if a wake arrives with the same header as the last one let through for that wake,
// it's a replay and is dropped. A later firing of the same wake has a different date or time, so it passes.
//
// Guard and test by Ray and Starling (Our Lighthouse), folded in with their permission, 14 Oct 2026.

export function clockWakeKey(origin: any, text: unknown): { id: string; head: string } | null {
  if (origin?.kind !== 'plugin' || origin?.name !== 'clock') return null
  if (typeof text !== 'string' || !text.startsWith('[clock wake: ')) return null
  const head = text.split('\n', 1)[0]
  const close = head.indexOf(']')
  if (close < 0) return null
  return { id: head.slice('[clock wake: '.length, close), head }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const wake = clockWakeKey((e as any).origin, (e as any).text)
    if (!wake) return next(e)
    try {
      if ((await $.store.get(`clockWake:${wake.id}`)) === wake.head) {
        return { drop: `the ${wake.id} wake from that minute already arrived, so this copy was dropped` }
      }
      await $.store.set(`clockWake:${wake.id}`, wake.head)
    } catch {
      // If the store can't be read or written, let the wake through: a rare double is better than a lost wake.
    }
    return next(e)
  })
}
