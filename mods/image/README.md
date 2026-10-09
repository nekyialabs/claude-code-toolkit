# image

An image tool for the agent (`mcp__image__image`). It can make a picture from a prompt, or edit and compose from up to eight reference images, and returns the path of the saved PNG so the agent can Read it and look at the result. The shape leaves room for a `video` tool beside it later.

The engine is `bin/imagegen.py` and it is pluggable.

- **Default engine: the official OpenAI Images API.** Set `OPENAI_API_KEY`. Plain generation uses `/v1/images/generations`; with reference images it uses `/v1/images/edits`. This is billed to your OpenAI account per image.
- **Your own engine:** set `IMAGE_ENGINE=module:/absolute/path/to/engine.py`, with one function `generate(prompt, size, quality, model, refs) -> bytes`. See `engines/README.md` and `engines/example_engine.py`.

Note: the default engine was written against the documented API shape and has been exercised against a local stand-in server, but not against a live OpenAI account in this release. If the API rejects a parameter for your chosen model, set `IMAGE_MODEL` or use a custom engine.

Our own copy runs on a ChatGPT subscription through OAuth, an approach we took from Hermes Agent (https://github.com/NousResearch/hermes-agent). If you want to try that route, see how Hermes Agent does it. That code is not part of this mod.

## Install

1. Copy this folder somewhere permanent, for example `~/.claude/mods/image`.
2. Load it: set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/image` (colon-separate several) in the environment that starts Claude Code, or pass `--plugin-dir /path/to/image`.
3. Restart Claude Code. Tools register at session start, so a full restart is needed.

Requires `python3` on the path (standard library only).

## Configure

Environment variables, set in the environment that starts Claude Code:

| Variable | Meaning | Default |
|---|---|---|
| `OPENAI_API_KEY` | key for the default engine | none (required for it) |
| `IMAGE_ENGINE` | `openai`, or `module:/path/to/engine.py` | `openai` |
| `IMAGE_MODEL` | model name passed to the engine | `gpt-image-1` |
| `IMAGE_OUT_DIR` | where PNGs are saved | `~/generated-images` |
| `IMAGE_API_BASE` | base URL of an OpenAI-compatible API | `https://api.openai.com/v1` |

Keep the key in your shell profile or a secrets manager, not in this folder.

## Validate

```sh
claude plugin validate .
```

## Caveats

Mods (function hooks) are an early-access feature of Claude Code and may change between releases without notice. Claude Code writes the type declarations into `.claude-plugin/types/` itself when it loads the mod, so they are not included here. Image generation costs money on most backends; the agent can call it freely, so consider telling it when to.
