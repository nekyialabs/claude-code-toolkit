"""scribe-classifier: a local yes/no decision service for the scribe mod, wrapping the open Laya model
(loopback only). The wire shape is a plain JSON "system one" request: a state plus named questions.

  POST /v1/systemone  {"model": "laya", "state": <str|object|list>, "questions": {...},
                       "max_len"?: int}
                  ->  laya's own result, JSON: {"model": "laya", "answers": {...},
                      "usage": {...}, "routing": {"model": "multilingual", "revision": ...}}
  GET  /v1/models  -> {"object": "list", "data": [{"id": "laya", ...}]}
  GET  /health     -> {"status": "ok", ...counts and timings only}

Checkpoint: convaiinnovations/laya, subfolder multilingual (mmBERT-base, 322M), pinned revision,
loaded from a local directory whose files are checked against SHA256SUMS before any weight is
parsed. No network at runtime (run with HF_HUB_OFFLINE=1). One checkpoint, no Router, so a
request can never be routed to a different model.

Privacy: never logs request bodies, states, questions, answers or error messages derived from
them. Log lines carry counts, sizes, a truncation flag and timings only.

Priority: there is no batch endpoint. Every request is an interactive single-state call and one
forward pass runs at a time (LOCK), so an interactive request is never queued behind a batch;
it waits at most for the one call already running.

Auth: binds loopback only (any other host is refused at startup). If CLASSIFIER_KEY_FILE names a
file, POST /v1/systemone requires `Authorization: Bearer <contents>`; that keeps other local
users of a shared box from spending this service. /health and /v1/models stay open (they reveal
nothing about any request).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("CLASSIFIER_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLASSIFIER_PORT", "8765"))
THREADS = int(os.environ.get("CLASSIFIER_THREADS", "4"))
DATA_DIR = os.environ.get("CLASSIFIER_DATA_DIR", os.path.expanduser("~/.local/share/scribe-classifier"))
MODEL_DIR = os.environ.get("CLASSIFIER_MODEL_DIR", os.path.join(DATA_DIR, "models", "laya-multilingual-55cf4c4e"))
SUMS_FILE = os.environ.get("CLASSIFIER_SHA256SUMS", os.path.join(DATA_DIR, "SHA256SUMS"))
REVISION = os.environ.get("CLASSIFIER_REVISION", "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851")
KEY_FILE = os.environ.get("CLASSIFIER_KEY_FILE", "")
# Default token budget per question sequence. The checkpoint ships 1024 (~768 for the state);
# the encoder reads 8192 and short inputs answer identically at a larger budget (model card).
DEFAULT_MAX_LEN = int(os.environ.get("CLASSIFIER_MAX_LEN", "2048"))
MAX_LEN_CAP = int(os.environ.get("CLASSIFIER_MAX_LEN_CAP", "4096"))

# Request guards (mirroring laya-serve's limits).
MAX_BODY = 2 * 1024 * 1024
MAX_QUESTIONS = 64
MAX_STATE_CHARS = 50000
MAX_TOTAL_OPTIONS = 512

MODEL_NAME = "laya"
CHECKPOINT = "multilingual"
ACCEPTED_MODELS = {None, "laya", "laya-multilingual", "multilingual"}

if HOST not in ("127.0.0.1", "::1", "localhost"):
    sys.exit(f"scribe-classifier: refusing to bind non-loopback host {HOST!r}")

AGENT = None
KEY: bytes | None = None
LOCK = threading.Lock()  # one forward pass at a time; torch already uses THREADS cores
STARTED = time.time()
STATS = {"requests": 0, "questions": 0, "errors": 0, "truncated": 0, "infer_ms_total": 0.0}


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


def verify_sums(model_dir: str, sums_file: str) -> dict[str, str]:
    """Every file in SHA256SUMS must exist and match; refuse the load otherwise."""
    expected: dict[str, str] = {}
    with open(sums_file) as f:
        for line in f:
            if line.strip():
                digest, path = line.split(None, 1)
                expected[os.path.normpath(path.strip())] = digest.lower()
    if "model.safetensors" not in expected:
        sys.exit("scribe-classifier: SHA256SUMS has no entry for model.safetensors")
    for rel, digest in expected.items():
        h = hashlib.sha256()
        with open(os.path.join(model_dir, rel), "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != digest:
            sys.exit(f"scribe-classifier: digest mismatch for {rel}")
    return expected


def count_options(questions: dict) -> int:
    n = 0
    for q in questions.values():
        if isinstance(q, dict) and isinstance(q.get("criteria"), (dict, list)) and q.get("type") in ("choice", "score"):
            n += len(q["criteria"])
        else:
            n += 2
    return n


class Handler(BaseHTTPRequestHandler):
    server_version = "scribe-classifier/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # default access log replaced by our own content-free lines
        pass

    def _send(self, code: int, obj: dict, extra: dict | None = None) -> None:
        body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code: int, msg: str, log_msg: str | None = None) -> None:
        """`msg` goes to the client; only `log_msg` (or msg when it is content-free) is logged."""
        STATS["errors"] += 1
        self.close_connection = True  # body may be unread; don't reuse the stream
        log(f"{self.command} {self.path.split('?')[0]} {code} {log_msg if log_msg is not None else msg}")
        self._send(code, {"error": msg})

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/health":
            n = STATS["requests"]
            self._send(200, {
                "status": "ok", "model": MODEL_NAME, "checkpoint": CHECKPOINT, "revision": REVISION,
                "device": "cpu", "threads": THREADS, "max_len": DEFAULT_MAX_LEN, "busy": LOCK.locked(),
                "uptime_s": round(time.time() - STARTED),
                "requests": n, "questions": STATS["questions"], "errors": STATS["errors"],
                "truncated": STATS["truncated"],
                "avg_infer_ms": round(STATS["infer_ms_total"] / n) if n else None,
            })
        elif path == "/v1/models":
            self._send(200, {"object": "list", "data": [{
                "id": MODEL_NAME, "object": "model", "owned_by": "convaiinnovations",
                "checkpoint": f"convaiinnovations/laya/{CHECKPOINT}", "revision": REVISION,
                "types": ["noul", "choice", "score"]}]})
        else:
            self._err(404, "not found")

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/v1/systemone":
            return self._err(404, "not found")
        if KEY is not None:
            supplied = (self.headers.get("Authorization") or "").encode("utf-8", "surrogateescape")
            if not hmac.compare_digest(supplied, b"Bearer " + KEY):
                return self._err(401, "invalid or missing bearer token")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._err(400, "bad Content-Length")
        if n <= 0 or n > MAX_BODY:
            return self._err(413 if n > MAX_BODY else 400, f"body must be 1..{MAX_BODY} bytes")
        try:
            req = json.loads(self.rfile.read(n))
        except (ValueError, UnicodeDecodeError, RecursionError):
            return self._err(400, "invalid JSON")
        if not isinstance(req, dict):
            return self._err(400, "body must be a JSON object")
        model = req.get("model")
        if model is not None and (not isinstance(model, str) or model.strip().lower() not in ACCEPTED_MODELS):
            return self._err(400, f"unknown model; this service serves {MODEL_NAME!r}", "unknown model")
        state, questions = req.get("state"), req.get("questions")
        if state is None:
            return self._err(400, "'state' is required")
        if not isinstance(questions, dict) or not questions:
            return self._err(400, "'questions' must be a non-empty object")
        if len(questions) > MAX_QUESTIONS:
            return self._err(413, f"at most {MAX_QUESTIONS} questions")
        if count_options(questions) > MAX_TOTAL_OPTIONS:
            return self._err(413, f"at most {MAX_TOTAL_OPTIONS} answer options across questions")
        try:
            state_chars = len(state) if isinstance(state, str) else len(json.dumps(state, ensure_ascii=False))
        except (TypeError, ValueError, RecursionError):
            return self._err(400, "'state' must be JSON-serializable")
        if state_chars > MAX_STATE_CHARS:
            return self._err(413, f"state too large (> {MAX_STATE_CHARS} chars)")
        max_len = req.get("max_len", DEFAULT_MAX_LEN)
        if not isinstance(max_len, int) or isinstance(max_len, bool) or not 64 <= max_len <= MAX_LEN_CAP:
            return self._err(400, f"max_len must be an integer in 64..{MAX_LEN_CAP}")

        t0 = time.perf_counter()
        waited = 0.0
        try:
            with LOCK:
                waited = time.perf_counter() - t0
                result = AGENT.system_one(state, questions, max_len=max_len)
        except ValueError as e:
            # laya's question-validation messages name the question and the fix: fine for the
            # client, which sent them. Never logged (they can quote request content).
            return self._err(422, str(e), "question validation failed")
        except Exception as e:  # never echo or log content; type only
            return self._err(500, "inference failed", f"inference failed: {type(e).__name__}")
        dt = (time.perf_counter() - t0) * 1000
        usage = result.get("usage") or {}
        trunc = bool(usage.get("truncated"))
        STATS["requests"] += 1
        STATS["questions"] += len(questions)
        STATS["truncated"] += int(trunc)
        STATS["infer_ms_total"] += dt - waited * 1000
        log(f"POST /v1/systemone 200 q={len(questions)} state_chars={state_chars} body={n}B "
            f"in_tok={usage.get('input_tokens', '?')} truncated={int(trunc)} max_len={max_len} "
            f"wait={waited * 1000:.0f}ms {dt:.0f}ms")
        out = {**result, "model": MODEL_NAME,
               "routing": {"model": CHECKPOINT, "revision": REVISION, "reason": "single-checkpoint service"}}
        self._send(200, out, {"Server-Timing": f"inference;dur={dt - waited * 1000:.1f}"})


def main() -> None:
    global AGENT, KEY
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("USE_TF", "0")
    if KEY_FILE:
        with open(KEY_FILE, "rb") as f:
            KEY = f.read().strip()
        if len(KEY) < 32:
            sys.exit("scribe-classifier: key file too short (want >= 32 chars)")
    t0 = time.time()
    verify_sums(MODEL_DIR, SUMS_FILE)
    log(f"checkpoint digests verified in {time.time() - t0:.1f}s")
    import torch
    torch.set_num_threads(THREADS)
    import laya
    AGENT = laya.Agent(MODEL_DIR, device="cpu")
    AGENT.revision = REVISION
    AGENT.system_one("warm up", {"w": {"type": "noul", "instructions": "Is this a test?"}})
    log(f"laya {laya.__version__} {CHECKPOINT}@{REVISION[:8]} loaded in {time.time() - t0:.1f}s, "
        f"threads={THREADS}, max_len={DEFAULT_MAX_LEN}, auth={'on' if KEY else 'off'}")
    ThreadingHTTPServer.request_queue_size = 64
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f"listening on http://{HOST}:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
