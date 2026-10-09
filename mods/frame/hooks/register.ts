import type { Register } from 'claude-code'

// frame: appends a markdown file to the system prompt of sessions that were not launched with it.
// FRAME_FILE: path to the file (default: ~/.claude/frame.md).
// FRAME_SKIP=1: do nothing in this session (use it in a launcher that already passes the file with --system-prompt-file).

let frame: string | undefined

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await $.env.get('FRAME_SKIP')) === '1') return composed
    if (frame === undefined) {
      try {
        let file = await $.env.get('FRAME_FILE')
        if (!file) file = `${(await $.env.get('HOME')) ?? ''}/.claude/frame.md`
        frame = await $.fs.read(file)
      } catch { frame = '' }
    }
    if (!frame) return composed
    return { sections: [...composed.sections, { id: 'frame:frame', text: frame, scope: 'session' as const }] }
  })
}
