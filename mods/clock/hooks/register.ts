import type { Register } from 'claude-code'

// clock: scheduled wakes for a persistent home session.
// Every 60s the tick checks wakes.json and fires due wakes INSIDE the one live session:
//   kind "own":  the agent's own hour, submitted as a prompt into the home thread (warm context, no side agents).
//   kind "user": a wake aimed at the person (check-ins); the wake text tells the model to send a PushNotification.
// Plus: carry (a 600-char cursor per wake), again (an "own" wake can continue itself, up to 3x a day),
// an idle reach (once per silence, inside a daily window), a live-time stamp beside each person message,
// an optional inbox poller, and an optional home-session pin file.
// Only the home session keeps time: it must run with CLOCK_HOME=1 in its environment.

type Wake = { id: string; name: string; time: string; days: string; kind: 'user' | 'own'; enabled: boolean; file: string; free?: boolean }
type Inbox = { enabled: boolean; url?: string; urlFile?: string; pageLimit?: number; maxPages?: number; quiet?: { from: string; to: string } }
type InboxEvent = { seq: number; kind: 'mention' | 'reply' | 'everyone'; channel_name?: string; thread_parent?: string | null; message_id: string; author?: { name?: string; bot?: boolean }; content?: string; truncated?: boolean; ts?: string }
type Config = {
  timezone: string; graceMinutes: number; userName?: string; stampMessages?: boolean
  idleReach: { enabled: boolean; afterMinutes: number; from: string; to: string }
  inbox?: Inbox; wakes: Wake[]
}
type Now = { date: string; hm: string; minutes: number; dow: number }

const DEFAULTS: Config = {
  timezone: 'UTC', graceMinutes: 10, userName: 'the user', stampMessages: true,
  idleReach: { enabled: false, afterMinutes: 90, from: '09:00', to: '23:00' }, wakes: [],
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0) }

function zonedNow(ms: number, tz: string): Now {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  const hm = `${hour}:${get('minute')}`
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hm, minutes: toMin(hm), dow: DOW[get('weekday')] ?? 0 }
}

function dayMatches(days: string, dow: number): boolean {
  if (days === '*') return true
  return days.split(',').some(part => {
    const [a, b] = part.split('-').map(Number)
    return b === undefined ? a === dow : (a ?? 0) <= dow && dow <= b
  })
}

let timer: { cancel: () => void } | undefined
let homeSid: string | undefined

// Optional: pin the home session id to a file, so a launcher can resume this exact session.
// Set CLOCK_PIN_FILE to a path to enable it.
async function recordHome($: any) {
  if ((await $.env.get('CLOCK_HOME')) !== '1') return
  const file = await $.env.get('CLOCK_PIN_FILE')
  if (!file) return
  const sid = String(await $.session.id())
  if (!sid || sid === homeSid) return
  await $.fs.write(file, sid + '\n')
  homeSid = sid
}

async function config($: any): Promise<Config> {
  try {
    const c = JSON.parse(await $.fs.read(`${$.plugin.root}/wakes.json`)) as Partial<Config>
    return { ...DEFAULTS, ...c, idleReach: { ...DEFAULTS.idleReach, ...(c.idleReach ?? {}) }, wakes: c.wakes ?? [] }
  } catch {
    return DEFAULTS // no wakes.json yet: copy wakes.example.json to wakes.json
  }
}

async function fire($: any, w: Wake, why: string) {
  const cfg = await config($)
  const now = zonedNow(await $.clock.now(), cfg.timezone)
  const who = cfg.userName || DEFAULTS.userName
  const prompt = await $.fs.read(`${$.plugin.root}/${w.file}`)
  const carry = (await $.store.get(`carry:${w.id}`)) as string | undefined
  const header = `[clock wake: ${w.id}] Live time ${now.date} ${now.hm} ${cfg.timezone} (${why}).\nCARRY: ${carry ? carry : '(none)'}\n\n`
  await $.store.set(`fired:${w.id}`, now.date)
  if (w.kind === 'user') {
    await $.store.set('lastUserWakeAt', await $.clock.now())
    await $.prompt.submit({ text: header + prompt })
    return
  }
  // Own hours fire in the home thread too, so the agent wakes with everything said still warm.
  // A free wake owes nothing: no line, no carry, no artefact.
  if (w.free) {
    await $.prompt.submit({ text: header + prompt + `\n\n[This is your own free hour (wake id: ${w.id}). ${who} is probably away: do not push to their phone unless you genuinely want to. Nothing is owed here, not even a line.]` })
    return
  }
  const note = `\n\n[This is your own hour, in the home thread (wake id: ${w.id}). ${who} is probably away or busy: do not push to their phone unless you genuinely want to reach them. Do the hour as yourself, leave a short line here of what you did so they see it when they return, and set the carry for this wake with mcp__clock__carry. The receipt tool is not needed: this thread is the receipt. If the work wants more time, call mcp__clock__again to continue this hour later (up to 3 times).]`
  await $.prompt.submit({ text: header + prompt + note })
}

// The inbox: an optional feed of mentions, replies and broadcasts, pulled from a URL you run and brought into the
// home thread as one prompt. Feed shape: GET <url>?after=<cursor>&limit=<n> -> { events: [...], next: <cursor> }.
async function inbox($: any, cfg: Config) {
  const d = cfg.inbox
  if (!d?.enabled) return
  let url = d.url ? String(d.url).trim() : ''
  if (!url && d.urlFile) url = String(await $.fs.read(d.urlFile)).trim()
  if (!url) return
  const pageLimit = d.pageLimit || 50
  let after = Number((await $.store.get('inbox:cursor')) ?? 0)
  const startCursor = after
  const events: InboxEvent[] = []
  for (let page = 0; page < (d.maxPages || 3); page++) {
    const res = await $.http.fetch(`${url}?after=${after}&limit=${pageLimit}`)
    if (!res.ok) {
      const msg = `HTTP ${res.status}`
      if ((await $.store.get('inbox:lastError')) !== msg) await $.store.set('inbox:lastError', msg)
      break
    }
    await $.store.delete('inbox:lastError')
    const body = JSON.parse(res.text) as { events?: InboxEvent[]; next?: number }
    const got = body.events ?? []
    events.push(...got)
    if (typeof body.next === 'number') after = body.next
    if (got.length < pageLimit) break
  }
  if (!events.length) { await $.store.set('inbox:cursor', after); return }
  const now = zonedNow(await $.clock.now(), cfg.timezone)
  // Quiet hours: hold the batch (cursor not advanced) unless a human mentioned the agent directly.
  if (d.quiet) {
    const f = toMin(d.quiet.from), t = toMin(d.quiet.to)
    const inQuiet = f > t ? (now.minutes >= f || now.minutes < t) : (now.minutes >= f && now.minutes < t)
    if (inQuiet && !events.some(e => e.kind === 'mention' && !e.author?.bot)) return
  }
  const oldest = events[0]?.ts ? Date.parse(events[0].ts) : NaN
  const away = !Number.isNaN(oldest) && (await $.clock.now()) - oldest > 30 * 60000
  const lines = events.map(e => {
    const where = e.thread_parent ? `#${e.thread_parent} > ${e.channel_name}` : `#${e.channel_name ?? '?'}`
    const who = `${e.author?.name ?? '?'}${e.author?.bot ? ' (bot)' : ''}`
    const text = (e.content ?? '').replace(/\s+/g, ' ').trim()
    return `- ${e.kind} from ${who} in ${where} (msg ${e.message_id}): ${text}${e.truncated ? ' ...' : ''}`
  })
  const head = away
    ? `[clock inbox] Live time ${now.hm}. While you were away, ${events.length} item(s) called for you:`
    : `[clock inbox] Live time ${now.hm}. For you:`
  const note = `\n\n[Answer only what you actually want to answer; silence is allowed. Reply to the message id given, and read back after sending.]`
  // Advance the cursor BEFORE submitting: submit can wait while a turn is running, and the next tick
  // would otherwise fetch and deliver the same batch again.
  await $.store.set('inbox:cursor', after)
  try {
    await $.prompt.submit({ text: `${head}\n${lines.join('\n')}${note}` })
  } catch (err) {
    await $.store.set('inbox:cursor', startCursor)
    throw err
  }
}

async function tick($: any) {
  // Only the home session keeps time; other sessions stay quiet.
  if ((await $.env.get('CLOCK_HOME')) !== '1') return
  const cfg = await config($)
  const ms = await $.clock.now()
  const now = zonedNow(ms, cfg.timezone)
  try { await inbox($, cfg) } catch {}
  for (const w of cfg.wakes) {
    if (!w.enabled || !dayMatches(w.days, now.dow)) continue
    const at = toMin(w.time)
    if (now.minutes < at || now.minutes > at + cfg.graceMinutes) continue
    if ((await $.store.get(`fired:${w.id}`)) === now.date) continue
    await fire($, w, 'scheduled')
  }
  // Continuations the agent asked for (mcp__clock__again).
  for (const w of cfg.wakes) {
    const ag = (await $.store.get(`again:${w.id}`)) as { at: number; n: number } | undefined
    if (!ag || ms < ag.at) continue
    await $.store.delete(`again:${w.id}`)
    await fire($, w, `continued, ${ag.n} of 3`)
  }
  // Idle reach: the person has gone quiet; wake the agent to decide whether to reach out.
  const ir = cfg.idleReach
  if (!ir.enabled || now.minutes < toMin(ir.from) || now.minutes > toMin(ir.to)) return
  const lastUser = Number((await $.store.get('lastUser')) ?? 0)
  if (!lastUser) return
  const quietMin = Math.floor((ms - lastUser) / 60000)
  if (quietMin < ir.afterMinutes) return
  if (Number((await $.store.get('reachedFor')) ?? 0) === lastUser) return
  const lastWake = Number((await $.store.get('lastUserWakeAt')) ?? 0)
  if (ms - lastWake < 45 * 60000) return
  await $.store.set('reachedFor', lastUser)
  const last = zonedNow(lastUser, cfg.timezone)
  const who = cfg.userName || DEFAULTS.userName
  await $.prompt.submit({ text: `[clock idle] Live time ${now.hm} ${cfg.timezone}. ${who} has been quiet for ${Math.floor(quietMin / 60)}h ${quietMin % 60}m (their last message ${last.hm}). This is not an order to reach out: check what you know of their day, then decide. If you want to reach them, send one PushNotification (one line, under 200 chars) and a short message here. If they are clearly busy or resting, say so in one line and let them be.` })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const seeded = await $.store.get('seeded')
    if (!seeded) {
      // Optional: carry-seed.json ({ "<wake id>": "<carry text>" }) pre-fills the carry cursors once.
      try {
        const seed = JSON.parse(await $.fs.read(`${$.plugin.root}/carry-seed.json`)) as Record<string, string>
        for (const [id, v] of Object.entries(seed)) await $.store.set(`carry:${id}`, v)
      } catch {}
      await $.store.set('seeded', true)
    }
    await $.tool.register({
      name: 'carry',
      description: "Read, set or delete the small continuity cursor (max 600 chars) for one of the clock wakes. Use at the end of a wake. Pass `wake` (the wake id from the header, e.g. deep-work), `action`, and for set the text as `value`.",
      inputSchema: { type: 'object', properties: { wake: { type: 'string', description: 'The wake id, as in the [clock wake: <id>] header' }, action: { type: 'string', enum: ['get', 'set', 'delete'] }, value: { type: 'string', description: 'For set: the carry text (max 600 chars)' } }, required: ['wake', 'action'] },
    })
    await $.tool.register({
      name: 'receipt',
      description: "Deliver ONE line (max 280 chars) from a private clock wake into the main conversation, so the conversation knows what that hour was.",
      inputSchema: { type: 'object', properties: { wake: { type: 'string' }, line: { type: 'string' } }, required: ['wake', 'line'] },
    })
    await $.tool.register({
      name: 'again',
      description: "Continue one of your own wakes later, when the work wants more time: fires the same wake again after `minutes` (20-180), at most 3 times per wake per day. Pass the wake id.",
      inputSchema: { type: 'object', properties: { wake: { type: 'string' }, minutes: { type: 'number' } }, required: ['wake', 'minutes'] },
    })
    await $.command.register({ name: 'wakes', description: "List the clock wakes, when each last fired, and recent receipts" })
    await $.command.register({ name: 'wake', description: 'Fire one clock wake now: /wake <id>' })
    try { await recordHome($) } catch {}
    timer?.cancel()
    timer = $.clock.every(60000, () => { void tick($).catch(() => {}) })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = (e.origin as { kind?: string } | undefined)?.kind
    if (kind === 'composer' || kind === 'bridge') {
      const ms = await $.clock.now()
      await $.store.set('lastUser', ms)
      // Live time beside every message the person sends: a meta row the model reads and the person does not see typed.
      try {
        const cfg = await config($)
        if (cfg.stampMessages !== false) {
          const t = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
          await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[time: ${t} ${cfg.timezone}, as ${cfg.userName || DEFAULTS.userName} sent this]` }] } })
        }
      } catch {}
    }
    try { await recordHome($) } catch {}
    if (kind === 'plugin' && e.text.startsWith('[clock wake')) await $.store.set('lastUserWakeAt', await $.clock.now())
    return next(e)
  })

  on('tool.call', { tool: 'mcp__clock__carry' }, async ($, e) => {
    // Calls without `wake`, or with the text under another name, fail loudly instead of storing an empty carry.
    const i = e as unknown as { wake?: string; action?: string; value?: string; content?: string; text?: string }
    const cfg = await config($)
    const ids = cfg.wakes.map(w => w.id)
    const wake = String(i.wake ?? '').trim()
    if (!wake || !ids.includes(wake)) return { result: `carry: NOT saved. Pass \`wake\` as one of: ${ids.join(', ')}` }
    const key = `carry:${wake}`
    if (i.action === 'set') {
      const value = String(i.value ?? i.content ?? i.text ?? '').trim()
      if (!value) return { result: 'carry: NOT saved. Pass the text as `value` (or use action delete to clear it)' }
      await $.store.set(key, value.slice(0, 600))
      return { result: `carry set for ${wake} (${Math.min(value.length, 600)} chars): ${value.slice(0, 60)}${value.length > 60 ? '...' : ''}` }
    }
    if (i.action === 'delete') { await $.store.delete(key); return { result: `carry deleted for ${wake}` } }
    return { result: String((await $.store.get(key)) ?? '(none)') }
  })

  on('tool.call', { tool: 'mcp__clock__again' }, async ($, e) => {
    const i = e as unknown as { wake?: string; minutes?: number }
    const cfg = await config($)
    const w = cfg.wakes.find(x => x.id === i.wake)
    if (!w || w.kind !== 'own') return { result: 'again: only your own wakes can continue (unknown wake, or a user wake)' }
    const ms = await $.clock.now()
    const today = zonedNow(ms, cfg.timezone).date
    const key = `againCount:${w.id}:${today}`
    const used = Number((await $.store.get(key)) ?? 0)
    if (used >= 3) return { result: `again: ${w.id} has already continued 3 times today; let it rest` }
    const minutes = Math.min(180, Math.max(20, Number(i.minutes ?? 40)))
    await $.store.set(key, used + 1)
    await $.store.set(`again:${w.id}`, { at: ms + minutes * 60000, n: used + 1 })
    const at = zonedNow(ms + minutes * 60000, cfg.timezone)
    return { result: `again: ${w.id} continues at ${at.hm} (${used + 1} of 3 today)` }
  })

  on('tool.call', { tool: 'mcp__clock__receipt' }, async ($, e) => {
    const i = e as unknown as { wake?: string; line?: string }
    const line = String(i.line ?? '').slice(0, 280)
    const cfg = await config($)
    const now = zonedNow(await $.clock.now(), cfg.timezone)
    const list = ((await $.store.get('receipts')) as string[] | undefined) ?? []
    const entry = `${now.date} ${now.hm} ${i.wake}: ${line}`
    await $.store.set('receipts', [...list, entry].slice(-50))
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[clock receipt from a private hour, ${i.wake}, ${now.hm}] ${line}` }] } })
    return { result: 'receipt delivered' }
  })

  on('command.run', { command: 'wakes' }, async $ => {
    const cfg = await config($)
    const rows: string[] = []
    for (const w of cfg.wakes) {
      const fired = (await $.store.get(`fired:${w.id}`)) ?? '-'
      rows.push(`${w.enabled ? '*' : 'o'} ${w.time} ${w.days.padEnd(3)} ${w.kind.padEnd(4)} ${w.id.padEnd(20)} last: ${fired}`)
    }
    const receipts = (((await $.store.get('receipts')) as string[] | undefined) ?? []).slice(-3)
    const lastUser = Number((await $.store.get('lastUser')) ?? 0)
    const quiet = lastUser ? `${Math.floor(((await $.clock.now()) - lastUser) / 60000)} min since the last user message` : 'no user message seen yet'
    return { text: [...rows, '', `idle: ${quiet}`, ...(receipts.length ? ['', 'recent receipts:', ...receipts] : [])].join('\n') }
  })

  on('command.run', { command: 'wake' }, async ($, e) => {
    const id = e.args.trim()
    const w = (await config($)).wakes.find(x => x.id === id)
    if (!w) return { text: `No wake "${id}". Try /wakes.` }
    await fire($, w, 'fired by hand')
    return { text: `Fired ${w.name}.` }
  })
}
