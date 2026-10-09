import type { Register } from 'claude-code'

// scribe: hears each exchange, asks a small classifier (a local endpoint by default) which memory "organs"
// (groups of tools) the exchange called for, and compares with the organs the agent actually used.
// shadow mode: log only. whisper mode: slip a nudge into the agent's context. off: do nothing.
// It never writes to memory. It goes deaf while hushed (private or sensitive conversations).
// Nothing is sent anywhere unless organs.json exists; remote endpoints also need allow_remote: true.

type Organ = { id: string; tools: string[]; threshold: number; instructions: string; true: string; false: string; nudges: string[] }
type Cfg = {
  mode: 'shadow' | 'whisper' | 'off'; model?: string; context: string; organs: Organ[]
  endpoint?: string // default: a local classifier service on loopback (see tools/classifier)
  allow_remote?: boolean // must be true to send anything to a non-localhost endpoint
  key_file?: string // file holding the bearer token for a localhost endpoint; remote endpoints use SCRIBE_API_KEY
  noul_labels?: { true: string; false: string } // neutral option labels for the yes/no question type
  max_len?: number // token budget per question sequence
  timezone?: string // IANA name used when printing times in /scribe (default UTC)
}
type Entry = { at: number; user: string; agent: string; used: string[]; scores: Record<string, number>; model?: string; ms?: number; err?: string; whispered?: string[]; verdicts?: Record<string, 'fair' | 'noise'> }

const LOCAL_ENDPOINT = 'http://127.0.0.1:8765/v1/systemone'
const HUSH_IDLE_MS = 60 * 60000

// True only for http(s) URLs whose host is this machine's loopback.
function isLoopback(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)
  } catch {
    return false
  }
}

const localKeys = new Map<string, string>()
async function localKey($: any, path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  const hit = localKeys.get(path)
  if (hit) return hit
  try {
    const k = String(await $.fs.read(path)).trim()
    if (k) localKeys.set(path, k)
    return k || undefined
  } catch {
    return undefined
  }
}

// Per-turn buffers (main loop only).
let userText: string[] = []
let agentText: string[] = []
let tools = new Set<string>()
let fromWake = false
let cachedKey: string | undefined

const OFF: Cfg = { mode: 'off', context: '', organs: [] }
let tz = 'UTC'

async function cfgOf($: any): Promise<Cfg> {
  try {
    const c = JSON.parse(await $.fs.read(`${$.plugin.root}/organs.json`)) as Cfg
    tz = c.timezone || 'UTC'
    return c
  } catch {
    return OFF // no organs.json yet: copy organs.example.json to organs.json to switch the scribe on
  }
}

async function apiKey($: any): Promise<string | undefined> {
  if (cachedKey) return cachedKey
  const fromEnv = await $.env.get('SCRIBE_API_KEY')
  if (fromEnv) return (cachedKey = String(fromEnv).trim())
  return undefined
}

// Latency per judge model.
function byModel(ok: Entry[]): string {
  const g: Record<string, number[]> = {}
  for (const e of ok) if (typeof e.ms === 'number') (g[e.model || 'unknown'] ??= []).push(e.ms)
  const parts = Object.entries(g).map(([m, xs]) => `${m}: avg ${Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)} ms over ${xs.length}`)
  return parts.length ? `judges · ${parts.join(' · ')}` : 'judges · none yet'
}

const snip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const clockTime = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))

async function isHushed($: any, now: number): Promise<boolean> {
  const until = Number((await $.store.get('hushUntil')) ?? 0)
  if (now < until) {
    // Still hushed: every turn keeps the hush alive for another idle hour.
    await $.store.set('hushUntil', Math.max(until, now + HUSH_IDLE_MS))
    return true
  }
  return false
}

async function record($: any, entry: Entry) {
  const log = ((await $.store.get('shadow')) as Entry[] | undefined) ?? []
  log.push(entry)
  await $.store.set('shadow', log.slice(-400))
}

async function classify($: any, snap: { user: string; agent: string; used: string[]; wake: boolean }) {
  const cfg = await cfgOf($)
  if (cfg.mode === 'off') return
  const at = await $.clock.now()
  const base: Entry = { at, user: snip(flat(snap.user), 90), agent: snip(flat(snap.agent), 90), used: snap.used, scores: {} }
  const endpoint = cfg.endpoint || LOCAL_ENDPOINT
  const local = isLoopback(endpoint)
  // Nothing the scribe hears leaves this machine unless organs.json says so in as many words.
  if (!local && cfg.allow_remote !== true) return record($, { ...base, err: 'refused: endpoint is not localhost and allow_remote is not true' })
  const key = local ? await localKey($, cfg.key_file) : await apiKey($)
  if (!local && !key) return record($, { ...base, err: 'no SCRIBE_API_KEY' })
  if (local && cfg.key_file && !key) return record($, { ...base, err: `cannot read key_file ${cfg.key_file}` })

  const questions: Record<string, unknown> = {}
  for (const o of cfg.organs) {
    const q: Record<string, unknown> = { type: 'noul', instructions: o.instructions, criteria: { true: o.true, false: o.false } }
    if (cfg.noul_labels) q.labels = cfg.noul_labels
    questions[o.id] = q
  }
  const state = {
    context: cfg.context,
    user_said: snap.wake ? '(no message from the user: the agent is answering one of its own scheduled wakes)' : snip(snap.user, 2000) || '(nothing)',
    agent_replied: snip(snap.agent, 3500),
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    const body: Record<string, unknown> = { model: cfg.model || 'laya', state, questions }
    if (cfg.max_len) body.max_len = cfg.max_len
    const r = await $.http.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    const ms = (await $.clock.now()) - at
    if (!r.ok) return record($, { ...base, ms, err: `http ${r.status}: ${snip(r.text, 160)}` })
    const out = JSON.parse(r.text) as { model?: string; answers?: Record<string, { noul?: number }> }
    const scores: Record<string, number> = {}
    for (const o of cfg.organs) {
      const p = out.answers?.[o.id]?.noul
      if (typeof p === 'number') scores[o.id] = Math.round(p * 1000) / 1000
    }
    const entry: Entry = { ...base, scores, model: out.model, ms }

    if (cfg.mode === 'whisper') {
      const missed = cfg.organs
        .filter(o => (scores[o.id] ?? 0) >= o.threshold && !snap.used.includes(o.id))
        .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))
        .slice(0, 2)
      if (missed.length) {
        const n = Number((await $.store.get('whisperCount')) ?? 0)
        await $.store.set('whisperCount', n + 1)
        const lines = missed.map(o => `${o.nudges[n % o.nudges.length] ?? o.id} (score ${(scores[o.id] ?? 0).toFixed(2)})`)
        entry.whispered = missed.map(o => o.id)
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[scribe: a nudge, not an order; you decide] ${lines.join('  ·  ')}` }] } })
      }
    }
    return record($, entry)
  } catch (err) {
    return record($, { ...base, err: snip(String(err), 160) })
  }
}

function organsUsed(cfg: Cfg, names: Set<string>): string[] {
  return cfg.organs.filter(o => o.tools.some(t => names.has(t))).map(o => o.id)
}

async function report($: any): Promise<string> {
  const cfg = await cfgOf($)
  const log = ((await $.store.get('shadow')) as Entry[] | undefined) ?? []
  const now = await $.clock.now()
  const hushUntil = Number((await $.store.get('hushUntil')) ?? 0)
  const head = [`scribe · mode: ${cfg.mode} · ${now < hushUntil ? `hushed (lifts after an idle hour, ${clockTime(hushUntil)} at the earliest)` : 'listening'} · ${log.length} exchanges heard`]
  const ok = log.filter(e => !e.err)
  const errs = log.length - ok.length
  if (errs) head.push(`errors: ${errs} (last: ${log.filter(e => e.err).slice(-1)[0]?.err})`)
  if (!ok.length) return [...head, '', 'Nothing classified yet.'].join('\n')

  const rows = ['', 'organ          judge-yes  used  caught  missed  extra   fair  noise   (judge-yes = p >= threshold; fair/noise = the agent verdicts)']
  for (const o of cfg.organs) {
    let yes = 0, used = 0, caught = 0, missed = 0, extra = 0, fair = 0, noise = 0
    for (const e of ok) {
      const y = (e.scores[o.id] ?? 0) >= o.threshold, u = e.used.includes(o.id)
      if (y) yes++
      if (u) used++
      if (y && u) caught++
      if (y && !u) missed++
      if (!y && u) extra++
      if (e.verdicts?.[o.id] === 'fair') fair++
      if (e.verdicts?.[o.id] === 'noise') noise++
    }
    rows.push(`${o.id.padEnd(14)} ${String(yes).padStart(7)} ${String(used).padStart(5)} ${String(caught).padStart(7)} ${String(missed).padStart(7)} ${String(extra).padStart(6)} ${String(fair).padStart(5)} ${String(noise).padStart(6)}`)
  }
  const recent = ok.slice(-6).map(e => {
    const flags = cfg.organs.filter(o => (e.scores[o.id] ?? 0) >= o.threshold).map(o => `${o.id} ${(e.scores[o.id] ?? 0).toFixed(2)}`)
    const t = clockTime(e.at)
    return `${t} ${e.model || 'judge'}: ${flags.join(', ') || '-'} | used: ${e.used.join(', ') || '-'}${e.whispered ? ` | whispered: ${e.whispered.join(', ')}` : ''}${e.verdicts ? ` | judged: ${Object.entries(e.verdicts).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}\n      "${flat(e.agent)}"`
  })
  return [...head, '', '```', ...rows.slice(1), '```', '', byModel(ok), '', 'recent:', ...recent.map(r => `- ${r}`)].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'hush',
      description: "Make the scribe go deaf: nothing from this conversation is sent to its classifier while hushed. Call it yourself when a private or sensitive conversation begins. It lifts on its own after an hour with no turns, or with action 'wake'.",
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['hush', 'wake'] } } },
    })
    await $.tool.register({
      name: 'judge',
      description: "Give your verdict on what the scribe's judge (the classifier) proposed: for one organ on a recent exchange, 'fair' (it read it right, whether or not you acted) or 'noise' (it was wrong). The judge proposes; you decide. back=0 is the latest heard exchange, 1 the one before.",
      inputSchema: { type: 'object', properties: { organ: { type: 'string' }, verdict: { type: 'string', enum: ['fair', 'noise'] }, back: { type: 'number' } }, required: ['organ', 'verdict'] },
    })
    await $.command.register({ name: 'scribe', description: "The scribe: what its judge noticed vs which memory organs were used. /scribe [hush|wake|shadow|whisper|off|clear]" })
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId) return stored
    try {
      const m = e.message
      const kind = (e.origin as { kind?: string } | undefined)?.kind
      if (e.door === 'prompt' && m.type === 'user') {
        const text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text as string).join('\n')
        if (kind === 'composer' || kind === 'bridge') userText.push(text)
        else if (kind === 'plugin' && text.startsWith('[clock')) fromWake = true
      } else if (e.door === 'response' && m.type === 'assistant') {
        for (const b of m.content as any[]) {
          if (b.type === 'text' && b.text) agentText.push(b.text as string)
          if (b.type === 'tool_use' && b.name) tools.add(b.name as string)
        }
      }
    } catch {}
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const snap = { user: userText.join('\n\n'), agent: agentText.join('\n\n'), names: tools, wake: fromWake && userText.length === 0 }
    userText = []; agentText = []; tools = new Set(); fromWake = false
    if (e.isAborted || !snap.agent.trim()) return next(e)
    if (await isHushed($, await $.clock.now())) return next(e)
    const cfg = await cfgOf($)
    const used = organsUsed(cfg, snap.names)
    $.clock.after(1, () => { void classify($, { user: snap.user, agent: snap.agent, used, wake: snap.wake }).catch(() => {}) })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__scribe__hush' }, async ($, e) => {
    const i = e as unknown as { action?: string }
    if (i.action === 'wake') { await $.store.set('hushUntil', 0); return { result: 'scribe listening again' } }
    await $.store.set('hushUntil', (await $.clock.now()) + HUSH_IDLE_MS)
    userText = []; agentText = []; tools = new Set()
    return { result: 'scribe hushed: nothing goes to the classifier until an hour passes with no turns, or you wake it' }
  })

  on('tool.call', { tool: 'mcp__scribe__judge' }, async ($, e) => {
    const i = e as unknown as { organ?: string; verdict?: string; back?: number }
    const log = ((await $.store.get('shadow')) as Entry[] | undefined) ?? []
    const ok = log.filter(x => !x.err)
    const target = ok[ok.length - 1 - Math.max(0, Math.floor(Number(i.back ?? 0)))]
    if (!target) return { result: 'no such exchange' }
    const organ = String(i.organ ?? ''), verdict = i.verdict === 'noise' ? 'noise' : 'fair'
    target.verdicts = { ...(target.verdicts ?? {}), [organ]: verdict }
    await $.store.set('shadow', log)
    return { result: `judged ${organ} ${verdict} on "${target.agent.slice(0, 50)}..." (score ${(target.scores[organ] ?? 0).toFixed(2)})` }
  })

  on('command.run', { command: 'scribe' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'hush') { await $.store.set('hushUntil', (await $.clock.now()) + HUSH_IDLE_MS); return { text: 'scribe hushed.' } }
    if (arg === 'wake') { await $.store.set('hushUntil', 0); return { text: 'scribe listening.' } }
    if (arg === 'clear') { await $.store.set('shadow', []); return { text: 'shadow log cleared.' } }
    if (arg === 'shadow' || arg === 'whisper' || arg === 'off') {
      const path = `${$.plugin.root}/organs.json`
      const cfg = await cfgOf($)
      cfg.mode = arg
      await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n')
      return { text: `scribe mode: ${arg}` }
    }
    return { text: await report($) }
  })
}
