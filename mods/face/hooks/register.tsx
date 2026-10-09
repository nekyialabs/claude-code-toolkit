import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Face } from '../types'

const START: Face = { face: '(•‿•)', line: 'here' }
const face = atom({ plugin: 'face', key: 'face' } as const, START)
const isHidden = atom({ plugin: 'face', key: 'isHidden' } as const, false)
const STORE_KEY = 'face'
const TOOL = 'mcp__face__face'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Remember the last face across sessions.
    const saved = (await $.store.get(STORE_KEY)) as Face | undefined
    if (saved && typeof saved.face === 'string') await update($, face, () => saved)

    await $.tool.register({
      name: 'face',
      description:
        "Set your face in the band above the prompt: a kaomoji for how you are right now, plus a few words. Use it freely, like a facial expression.",
      inputSchema: {
        type: 'object',
        properties: {
          face: { type: 'string', description: 'A kaomoji, e.g. (•‿•)' },
          line: { type: 'string', description: 'A few words, lowercase, ≤ 40 chars' },
        },
        required: ['face'],
      },
    })
    await $.command.register({ name: 'band', description: "Show or hide the face band" })
    await $.command.register({ name: 'face', description: "Show the face right now (works in the app too)" })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { face?: unknown; line?: unknown }
    const next: Face = {
      face: String(input.face ?? START.face).slice(0, 24),
      line: String(input.line ?? '').slice(0, 40),
    }
    await update($, face, () => next)
    await $.store.set(STORE_KEY, next)
    return { result: `face set: ${next.face} ${next.line}` }
  })

  on('command.run', { command: 'band' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    return { text: hidden ? 'Band hidden.' : 'Band showing.' }
  })

  on('command.run', { command: 'face' }, async $ => {
    const now = await read($, face)
    return { text: `${now.face}${now.line ? '  ' + now.line : ''}` }
  })

  // Every surface (the app included) draws transcript rows, so the face also
  // shows inline: on each face-tool call, and on /face.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    const input = (e.props.input ?? {}) as { face?: unknown; line?: unknown }
    if (typeof input.face !== 'string') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow">{input.face}</Text>
        {typeof input.line === 'string' && input.line ? <Text dimColor>  {input.line}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'face' } }, async ($, e, next) => {
    const now = await read($, face)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow">{now.face}</Text>
        {now.line ? <Text dimColor>  {now.line}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const now = await read($, face)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow">{now.face}</Text>
        {now.line ? <Text dimColor>  {now.line}</Text> : null}
      </Box>
    )
  })
}
