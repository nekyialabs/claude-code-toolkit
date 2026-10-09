# face

A small presence band above the prompt. The agent sets a kaomoji face and a few words for how it is right now (`mcp__face__face`), and the band shows it above your prompt. It also draws inline in the transcript whenever the face is set, and the last face is remembered across sessions.

- Tool: `face` (arguments `face`, up to 24 characters, and `line`, up to 40 characters).
- `/band` shows or hides the band.
- `/face` prints the current face (useful in surfaces without the band).

## Install

1. Copy this folder somewhere permanent, for example `~/.claude/mods/face`.
2. Load it: set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/face` (colon-separate several) in the environment that starts Claude Code, or pass `--plugin-dir /path/to/face`.
3. Restart Claude Code. Tools register at session start, so a full restart is needed.

## Configure

Nothing to configure. Tell the agent in your system prompt or frame that it can set its face whenever its state changes, like a facial expression.

## Validate

```sh
claude plugin validate .
```

## Caveats

Mods (function hooks) are an early-access feature of Claude Code and may change between releases without notice. This mod draws UI (`ui.render`), so it is the most likely to need updating when the surface changes. Claude Code writes the shared type declarations into `.claude-plugin/types/` itself when it loads the mod, so they are not included here; the small `types/index.d.ts` beside the hooks is this mod's own state typing.
