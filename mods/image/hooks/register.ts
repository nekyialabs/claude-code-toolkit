import type { Register } from 'claude-code'

// image: the agent's image tool. The engine is bin/imagegen.py, which is pluggable
// (default: the official OpenAI Images API with OPENAI_API_KEY; see README.md and engines/README.md).
// Shaped so a `video` tool can join later beside `image`.
const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'image',
      description: "Make a picture (or edit one, given reference images) through the configured image engine. Returns the saved PNG path; Read it to see the result. Can take up to a few minutes.",
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The full prompt: style, subject, scene, light, composition, and what to avoid.' },
          size: { type: 'string', enum: SIZES, description: 'Default 1536x1024 (landscape). 1024x1536 portrait, 1024x1024 square.' },
          quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default high.' },
          refs: { type: 'array', items: { type: 'string' }, description: 'Optional reference images (local paths or https URLs, up to 8). With refs, the call edits/composes from them.' },
          name: { type: 'string', description: 'Optional short slug for the file name.' },
        },
        required: ['prompt'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__image__image' }, async ($, e) => {
    const i = e as unknown as { prompt?: string; size?: string; quality?: string; refs?: string[]; name?: string }
    const engine = `${$.plugin.root}/bin/imagegen.py`
    const argv = ['python3', engine, '--prompt', String(i.prompt ?? '')]
    if (i.size && SIZES.includes(i.size)) argv.push('--size', i.size)
    if (i.quality) argv.push('--quality', String(i.quality))
    if (i.name) argv.push('--name', String(i.name))
    for (const r of (Array.isArray(i.refs) ? i.refs : []).slice(0, 8)) argv.push('--ref', String(r))
    try {
      const r = await $.process.run(argv, { timeoutMs: 330000 })
      const line = r.stdout.trim().split('\n').pop() ?? ''
      try {
        const out = JSON.parse(line) as { ok: boolean; path?: string; error?: string; size?: string; mode?: string; model_requested?: string }
        if (out.ok) return { result: `image saved: ${out.path} (${out.mode}, ${out.size}, model ${out.model_requested}). Read the file to see it.` }
        return { result: `image failed: ${out.error ?? 'unknown error'}` }
      } catch {
        return { result: `image failed: exit ${r.exitCode}: ${(r.stderr || line).trim().slice(0, 300)}` }
      }
    } catch (err) {
      return { result: `image failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
