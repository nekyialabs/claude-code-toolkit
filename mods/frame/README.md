# frame

Adds your own operating frame to the system prompt. Write the frame once as a markdown file (who the agent is, how it should work, house rules) and this mod appends it to the system prompt of every session that was not already launched with it, for example a session opened from a desktop app or a plain `claude` in a terminal.

The file is read once per session start and added as a session-scoped system prompt section.

## Install

1. Copy this folder somewhere permanent, for example `~/.claude/mods/frame`.
2. Load it: set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/frame` (colon-separate several) in the environment that starts Claude Code, or pass `--plugin-dir /path/to/frame`.
3. Restart Claude Code.

## Configure

- Write your frame to `~/.claude/frame.md` (see `frame.example.md` for a starting shape), or point `FRAME_FILE` at another path.
- `FRAME_SKIP=1`: set this in a launcher that already passes the same file with `--system-prompt-file`, so the frame is not added twice.

If the file is missing or empty the mod does nothing.

## Validate

```sh
claude plugin validate .
```

## Caveats

Mods (function hooks) are an early-access feature of Claude Code and may change between releases without notice. Claude Code writes the type declarations into `.claude-plugin/types/` itself when it loads the mod, so they are not included here. A long frame costs tokens in every session; keep it tight.
