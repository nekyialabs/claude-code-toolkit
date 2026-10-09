# scribe-classifier

A small local decision service for the scribe mod. It wraps the open Laya model (`convaiinnovations/laya`, multilingual checkpoint, Apache-2.0) and answers yes/no questions about a piece of text.

- `POST /v1/systemone` with `{"model": "laya", "state": ..., "questions": {...}}`; `GET /v1/models`; `GET /health`.
- Binds to loopback only (any other host is refused at startup). Optional bearer token via `CLASSIFIER_KEY_FILE`.
- Never logs request bodies, states, questions or answers: counts, sizes and timings only.
- CPU only, one forward pass at a time, no network at runtime (`HF_HUB_OFFLINE=1`).

## Set up

1. Create a virtualenv and install `requirements.txt` (the first lines of that file show how to get the CPU build of torch).
2. Download the checkpoint yourself from Hugging Face, into `~/.local/share/scribe-classifier/models/laya-multilingual-55cf4c4e/` (or set `CLASSIFIER_MODEL_DIR`), at the revision named in `CLASSIFIER_REVISION` (default `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851`).
3. Write a `SHA256SUMS` file (`sha256sum` format, paths relative to the model directory, including `model.safetensors`) at `~/.local/share/scribe-classifier/SHA256SUMS`. Every listed file is digest-checked before any weight is loaded.
4. Run it: `python server.py`, or install `systemd/scribe-classifier.service` as a user unit.

Environment variables: `CLASSIFIER_HOST`, `CLASSIFIER_PORT` (default 8765), `CLASSIFIER_THREADS`, `CLASSIFIER_MAX_LEN`, `CLASSIFIER_MAX_LEN_CAP`, `CLASSIFIER_DATA_DIR`, `CLASSIFIER_MODEL_DIR`, `CLASSIFIER_SHA256SUMS`, `CLASSIFIER_REVISION`, `CLASSIFIER_KEY_FILE`.

## Quality notes

The checkpoint ships uncalibrated, and on typed decisions zero-shot it is close to chance. The default yes/no labels lean heavily towards "no"; neutral labels (`"noul_labels": {"true": "A", "false": "B"}` in the scribe's `organs.json`) reduce the errors a lot. Do not treat the probabilities as calibrated.
