# Changelog

## Unreleased

- **clock-guard (new):** a companion mod that drops a clock wake arriving twice for the same firing. Claude Code can replay a timer's `prompt.submit` when it replaces a lost hooks worker, and a mod can't see its own submits, so the guard lives in a separate mod and keys on the wake's header line. Guard and test by Ray and Starling.
- **clock:** `/wake <id>` now queues the wake on a one-second timer instead of submitting from inside `command.run`, which Claude Code 2.1.296 refuses. Fix by Ray and Starling.

## 0.1.0 (9 Oct 2026)

- First release: clock, frame, scribe, image and face.
