# scribe

A scribe for an agent's memory tools. After each exchange, a small classifier reads what was said and answers a few yes/no questions, one per memory "organ" (a group of tools): did the user just share a lasting fact, did a decision get made, did the agent make a prediction. The scribe compares those answers with the organs the agent actually used.

- **shadow** mode (the default in the example): only logs. `/scribe` prints a table of what the judge noticed against what was used (caught, missed, extra).
- **whisper** mode: when the judge is confident an organ was called for and the agent did not use it, a short nudge is slipped into the agent's context. The agent decides; it is never an order.
- **off**: does nothing. This is also what happens when there is no `organs.json`.

The scribe never writes to memory itself. Tools: `mcp__scribe__hush` (the agent goes deaf for private conversations; nothing is sent to the classifier until an hour passes with no turns) and `mcp__scribe__judge` (the agent marks a proposal as `fair` or `noise`, so you can see how good the judge is). Command: `/scribe [hush|wake|shadow|whisper|off|clear]`.

## Privacy

The exchange text goes to the classifier endpoint, so by default that endpoint must be on the same machine (loopback). A non-loopback endpoint is refused unless `allow_remote` is `true`, and then it needs a bearer token in the `SCRIBE_API_KEY` environment variable. Nothing is sent at all until you create `organs.json`.

## Install

1. Copy this folder somewhere permanent, for example `~/.claude/mods/scribe`.
2. Load it: set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/scribe` (colon-separate several) in the environment that starts Claude Code, or pass `--plugin-dir /path/to/scribe`.
3. Restart Claude Code.

## Configure

1. `cp organs.example.json organs.json` and edit it. Keys:
   - `mode`: `shadow`, `whisper` or `off`.
   - `endpoint`: the classifier URL (default `http://127.0.0.1:8765/v1/systemone`), `model`, `key_file` (optional file holding a bearer token for a loopback endpoint), `allow_remote`, `noul_labels`, `max_len`, `timezone`.
   - `context`: one paragraph telling the judge what it is judging.
   - `organs`: each with an `id`, the `tools` that count as using it (full tool names, such as `mcp__memory__remember`), a `threshold`, the question (`instructions`, `true`, `false`) and a list of `nudges`.
   The example organs use placeholder tool names; change them to your own memory tools.
2. Run a classifier. `tools/classifier/` is a small loopback server around the open Laya model; see its README. Any service that speaks the same request and response shape will do.
3. Environment: `SCRIBE_API_KEY` (only for a remote endpoint).

## Validate

```sh
claude plugin validate .
```

## Caveats

Mods (function hooks) are an early-access feature of Claude Code and may change between releases without notice. Claude Code writes the type declarations into `.claude-plugin/types/` itself when it loads the mod, so they are not included here. Small classifiers are noisy: start in shadow mode, use `judge` for a while, and only then consider whisper.
