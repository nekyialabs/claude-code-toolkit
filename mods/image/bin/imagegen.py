#!/usr/bin/env python3
"""Image engine for the image mod: generate or edit images through a pluggable backend.

Default engine: the official OpenAI Images API (needs OPENAI_API_KEY in the environment).

Usage:
  imagegen.py --prompt "..." [--size 1536x1024] [--quality high] [--ref path-or-url ...] [--out DIR] [--model M] [--name SLUG]
Prints one JSON line: {"ok": true, "path": ..., "mode": "generate"|"edit", "model_requested": ..., "size": ...}
or {"ok": false, "error": ...}. Secrets are never printed.

Environment:
  OPENAI_API_KEY   key for the default engine (required for it)
  IMAGE_ENGINE     "openai" (default), or "module:/path/to/engine.py" to load your own engine (see engines/README.md)
  IMAGE_MODEL      model name (default gpt-image-1)
  IMAGE_OUT_DIR    where PNGs are saved (default ~/generated-images)
  IMAGE_API_BASE   base URL for the OpenAI-compatible API (default https://api.openai.com/v1)
"""
import argparse, base64, datetime, importlib.util, json, mimetypes, os, sys, urllib.error, urllib.parse, urllib.request, uuid

DEFAULT_MODEL = "gpt-image-1"
DEFAULT_OUT = os.path.expanduser("~/generated-images")
API_BASE = os.environ.get("IMAGE_API_BASE", "https://api.openai.com/v1").rstrip("/")
UA = "claude-code-toolkit-image/0.1"
MAX_REF_BYTES = 20 * 1024 * 1024


def http(url, data=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=data, headers=dict(headers or {}), method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def load_ref(ref):
    """-> (bytes, mime, filename) for a local path, an https URL or a data: URL."""
    if ref.startswith("data:"):
        head, _, body = ref.partition(",")
        mime = head[5:].split(";")[0] or "image/png"
        raw = base64.b64decode(body)
        name = "ref"
    elif ref.startswith(("http://", "https://")):
        st, hd, raw = http(ref, timeout=60)
        if st != 200:
            raise RuntimeError(f"could not fetch reference {ref}: HTTP {st}")
        mime = (hd.get("Content-Type") or "image/png").split(";")[0]
        name = os.path.basename(urllib.parse.urlparse(ref).path) or "ref"
    else:
        path = os.path.expanduser(ref)
        with open(path, "rb") as f:
            raw = f.read()
        mime = mimetypes.guess_type(path)[0] or "image/png"
        name = os.path.basename(path)
    if len(raw) > MAX_REF_BYTES:
        raise RuntimeError("reference image too big (limit 20 MB)")
    return raw, mime, name


def multipart(fields, files):
    """Build a multipart/form-data body. fields: [(name, str)]; files: [(name, filename, mime, bytes)]."""
    boundary = uuid.uuid4().hex
    out = []
    for k, v in fields:
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, fn, mime, raw in files:
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fn}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
        out.append(raw)
        out.append(b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def engine_openai(prompt, size, quality, model, refs):
    """Official OpenAI Images API. No refs: /images/generations. With refs: /images/edits. Returns PNG bytes."""
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    auth = {"Authorization": f"Bearer {key}", "User-Agent": UA}
    if refs:
        files = []
        for r in refs[:8]:
            raw, mime, name = load_ref(r)
            files.append(("image[]", name, mime, raw))
        body, ctype = multipart([("model", model), ("prompt", prompt), ("size", size), ("quality", quality), ("n", "1")], files)
        st, _, raw = http(f"{API_BASE}/images/edits", body, dict(auth, **{"Content-Type": ctype}))
    else:
        payload = {"model": model, "prompt": prompt, "n": 1, "size": size, "quality": quality}
        st, _, raw = http(f"{API_BASE}/images/generations", json.dumps(payload).encode(), dict(auth, **{"Content-Type": "application/json"}))
    if st >= 400:
        raise RuntimeError(f"images API HTTP {st}: {raw[:400].decode('utf-8', 'replace')}")
    item = (json.loads(raw).get("data") or [{}])[0]
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    if item.get("url"):
        st, _, img = http(item["url"], timeout=120)
        if st == 200:
            return img
    raise RuntimeError("no image in the response")


def load_engine(spec):
    """IMAGE_ENGINE: 'openai' (built in) or 'module:/path/to/file.py' exposing generate(prompt, size, quality, model, refs) -> bytes."""
    if spec in ("", "openai"):
        return engine_openai
    if spec.startswith("module:"):
        path = os.path.expanduser(spec[len("module:"):])
        s = importlib.util.spec_from_file_location("image_engine_plugin", path)
        mod = importlib.util.module_from_spec(s)
        s.loader.exec_module(mod)
        return mod.generate
    raise RuntimeError(f'unknown IMAGE_ENGINE "{spec}" (use "openai" or "module:/path/to/engine.py")')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--size", default="1536x1024")
    ap.add_argument("--quality", default="high")
    ap.add_argument("--model", default=os.environ.get("IMAGE_MODEL", DEFAULT_MODEL))
    ap.add_argument("--ref", action="append", default=[])
    ap.add_argument("--out", default=os.environ.get("IMAGE_OUT_DIR", DEFAULT_OUT))
    ap.add_argument("--name", default="")
    a = ap.parse_args()
    try:
        generate = load_engine(os.environ.get("IMAGE_ENGINE", "openai").strip())
        img = generate(a.prompt, a.size, a.quality, a.model, a.ref[:8])
        out_dir = os.path.expanduser(a.out)
        os.makedirs(out_dir, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
        slug = "".join(c if c.isalnum() else "-" for c in (a.name or a.prompt[:40]).lower()).strip("-")[:40] or "image"
        path = os.path.join(out_dir, f"{stamp}_{slug}.png")
        with open(path, "wb") as f:
            f.write(img)
        print(json.dumps({"ok": True, "path": path, "mode": "edit" if a.ref else "generate", "model_requested": a.model, "size": a.size}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:600]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
