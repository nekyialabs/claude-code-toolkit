# clock

A clock for an AI that lives in one persistent Claude Code session. Every 60 seconds it checks a schedule and, when a wake is due, submits it as a prompt into the live session, so the agent wakes with the whole conversation still warm. There are no side agents and no separate processes: the thread is the record.

What it does:

- **Wakes.** Scheduled prompts from `wakes.json`. A wake is either `user` (aimed at the person: a check-in, with a push notification to their phone) or `own` (the agent's private hour in the same thread). A `free` wake owes nothing at all.
- **Carry.** A small continuity note (600 characters) per wake, set by the agent with `mcp__clock__carry` and shown at the top of that wake next time.
- **Again.** An `own` wake can continue itself later (`mcp__clock__again`, 20 to 180 minutes, up to three times a day).
- **Idle reach.** If the person has been quiet for a set time inside a daily window, the agent is woken once to decide whether to reach out.
- **Live-time stamp.** A small meta line with the current time is added beside each message the person sends.
- **Inbox (optional).** Polls a URL you run for mentions and replies, and delivers them as one prompt.
- **Commands.** `/wakes` lists wakes and when each last fired; `/wake <id>` fires one now.

## Install

1. Copy this folder somewhere permanent, for example `~/.claude/mods/clock`.
2. Load it: either set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/clock` (colon-separate several) in the environment that starts Claude Code, or pass `--plugin-dir /path/to/clock` on the command line.
3. Restart Claude Code. Tools are registered at session start, so a full restart is needed; other edits hot-reload, but a hot reload stops the timer until the next session start, so restart after editing.

## Configure

1. `cp wakes.example.json wakes.json`, then edit it. Fields: `timezone` (an IANA name such as `Europe/London`; default `UTC`), `graceMinutes`, `userName` (how the wake text refers to the person), `stampMessages`, `idleReach`, `inbox`, and `wakes`.
2. Each wake has `id`, `name`, `time` (`HH:MM` in your timezone), `days` (`*`, or weekday numbers with 0 as Sunday, such as `1-5` or `0,6`), `kind` (`user` or `own`), `enabled`, `file`, and optionally `free`. Write each wake as a markdown file; see `wakes/` for three neutral examples. The wake text is your own to write in your own voice.
3. Environment variables:
   - `CLOCK_HOME=1` is **required** in the home session. The clock keeps time only where this is set, so other sessions (a second terminal, a remote window) stay quiet.
   - `CLOCK_PIN_FILE` (optional): a file path. When set, the home session id is written there so a launcher can resume exactly that session.
4. Optional `carry-seed.json`: `{ "<wake id>": "<text>" }` pre-fills carry notes once, on first run.
5. Inbox feed shape, if you enable it: `GET <url>?after=<cursor>&limit=<n>` returning `{ "events": [ { "seq", "kind": "mention|reply|everyone", "channel_name", "message_id", "author": { "name", "bot" }, "content", "ts" } ], "next": <cursor> }`. Put the URL in `url`, or in a file named by `urlFile` if it is a secret.

A minimal launcher, for reference:

```sh
CLOCK_HOME=1 CLAUDE_CODE_PLUGIN_DIRS="$HOME/.claude/mods/clock" claude --continue
```

## Validate

```sh
claude plugin validate .
```

## Caveats

Mods (function hooks) are an early-access feature of Claude Code. The surface may change between releases without notice, and this mod may need updating when it does. Claude Code writes the type declarations the mod uses into `.claude-plugin/types/` itself when it loads the mod, so they are not included here. Wake prompts spend real model turns: keep the schedule modest.
