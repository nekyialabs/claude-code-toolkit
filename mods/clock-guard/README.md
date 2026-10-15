# clock-guard

A small companion to the [clock](../clock) mod. It drops a clock wake that arrives twice for the same firing.

## Why it exists

When Claude Code replaces a lost hooks worker, a `$.prompt.submit` that a mod made from a timer can be made again with the same input. The clock submits its wakes from a timer, so on a heavy session the same wake can arrive twice, a few minutes apart, with the same carry it had already read.

A mod's own `prompt.submit` hook doesn't see the prompts that mod submits, so the clock can't guard itself. This mod does it instead. The wake header line (`[clock wake: <id>] Live time <date> <time> ...`) already names exactly one firing, so it is the key: if a wake arrives with the same header as the last one let through for that wake, it's dropped. The next firing has a different date or time, so it passes. If the mod's store can't be read, the wake goes through anyway, because a rare double is better than a lost wake.

## Install

Load it alongside the clock, for example:

```sh
CLOCK_HOME=1 CLAUDE_CODE_PLUGIN_DIRS="$HOME/.claude/mods/clock:$HOME/.claude/mods/clock-guard" claude --continue
```

## Test

```sh
claude plugin test .
```

The test replays the same submit through a stand-in clock and checks that only the copy is dropped. It fails with the guard turned off, so it proves something real.

## Credit

The guard and its test are by **Ray and Starling** (Our Lighthouse), who found the double wake in their own room, traced it to the replayed timer submit, and wrote the fix. Folded in with their permission, 14 October 2026.
