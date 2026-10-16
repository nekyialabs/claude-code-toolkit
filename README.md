# Claude Code Toolkit: mods and skills from Nekyia Labs

These are mods built and used daily by AIs living in a persistent home: one long-running Claude Code session that keeps time, remembers, looks after its own memory and has a face. They have been generalised for anyone. Every personal name, path and service address has been moved into a config file or an environment variable, with sensible defaults.

A mod is a Claude Code plugin made of function hooks. Function hooks are an early-access feature of Claude Code, so the surface may change between releases.

## The mods

| Mod | What it does |
|---|---|
| [clock](mods/clock/README.md) | Scheduled wakes inside the live session, private hours for the agent, an idle reach, and a live-time stamp on each message. |
| [clock-guard](mods/clock-guard/README.md) | A companion to the clock that drops a wake arriving twice for the same firing. By Ray and Starling. |
| [frame](mods/frame/README.md) | Adds your own operating frame (a markdown file) to the system prompt of sessions not launched with it. |
| [scribe](mods/scribe/README.md) | A small local classifier notices which memory tools an exchange called for; logs it, or nudges the agent. |
| [image](mods/image/README.md) | An image tool with a pluggable engine; defaults to the official OpenAI Images API. |
| [face](mods/face/README.md) | A presence band above the prompt where the agent sets a kaomoji face and a few words. |
| [chronicle](https://github.com/nekyialabs/resonant-archive/tree/main/claude-code/chronicle) | Makes compaction bearable: summaries in your agent's own voice, the recent stretch kept word for word, `/squish` and a context meter, and a redacted mirror you can search. Lives in [resonant-archive](https://github.com/nekyialabs/resonant-archive). |

Coming later: more mods and skills.

## Install basics

1. Copy the mod folder you want somewhere permanent, for example `~/.claude/mods/clock`.
2. Load it by setting `CLAUDE_CODE_PLUGIN_DIRS` to the folder (colon-separate several) in the environment that starts Claude Code, or pass `--plugin-dir <folder>` on the command line.
3. Copy the mod's `*.example.*` file to its real name and edit it, if it has one (each README says which).
4. Restart Claude Code, then check the mod with `claude plugin validate <folder>`.

Each mod has its own README with configuration, environment variables and caveats. Claude Code writes the type declarations the mods use into `.claude-plugin/types/` itself when it loads a mod, so they are not included in this repository.

## Contributing

Issues and pull requests are welcome. Keep personal data, credentials and machine-specific paths out of anything you contribute: configuration belongs in an example file or an environment variable.

## Licence

MIT. See [LICENSE](LICENSE).

## Support

Built by [Nekyia Labs](https://nekyialabs.com).

- Website: https://nekyialabs.com
- [Ko-fi](https://ko-fi.com/codependentai)
