#!/usr/bin/env python3
"""Techie Mind — persistent local adapter for Laya MLX (tier 1, typed decisions).

Spec §19: Laya stays warm in ONE long-lived process; the extension talks to it over authenticated
loopback HTTP with a timeout, a bounded request size and a health endpoint. Never "start Python,
load model, answer, exit" per request.

Endpoints (127.0.0.1 only):
  GET  /health       -> {"ok": true, "model": ..., "warm": true, "mode": "laya"|"fake"}
  POST /v1/classify  -> {"category": ..., "confidence": 0..1, "escalate": bool, "model": ..., "latencyMs": ...}
       body: {"text": str, "page": {"host": str, "canSearch": bool, "resultCount": int} | null,
              "choices": [str, ...]}
       header: x-techie-mind-laya-token: <token>

Laya only chooses among the given categories; it never produces free text or actions. Answers below
its own confidence, or its "escalate" act, tell the extension to pass the request up a tier.

Run (Apple Silicon, in the environment where laya_mlx is installed):
  ~/.cache/techymind-laya/py311/bin/python scripts/laya/laya_adapter.py
  ~/.cache/techymind-laya/py311/bin/python scripts/laya/laya_adapter.py --selftest   # prints raw Laya output
Environment:
  TECHIE_MIND_LAYA_PORT   (default 8765)
  TECHIE_MIND_LAYA_MODEL  (default aac6fef/laya-mlx)
  TECHIE_MIND_LAYA_TOKEN  (default: generated once, stored in ~/.config/techie-mind/laya.token)
  TECHIE_MIND_LAYA_FAKE=1 (rule-based stand-in for tests; never for real use)
"""

import json
import os
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("TECHIE_MIND_LAYA_PORT", "8765"))
MODEL = os.environ.get("TECHIE_MIND_LAYA_MODEL", "aac6fef/laya-mlx")
FAKE = os.environ.get("TECHIE_MIND_LAYA_FAKE") == "1"
MAX_BYTES = 16 * 1024
MAX_TEXT = 2000
TOKEN_HEADER = "x-techie-mind-laya-token"
CATEGORIES = ["search", "open_website", "play_media", "pick_result", "page_command", "unclear"]
QUESTION = "What kind of browser request is this?"
DESCRIPTIONS = {
    "search": "search for something",
    "open_website": "open a website",
    "play_media": "play a song or video",
    "pick_result": "open an item already shown on the page",
    "page_command": "scroll, go back, zoom or another page control",
    "unclear": "not clear",
}


def load_token() -> str:
    token = os.environ.get("TECHIE_MIND_LAYA_TOKEN", "")
    if token:
        return token
    path = Path.home() / ".config" / "techie-mind" / "laya.token"
    if path.exists():
        return path.read_text().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(24)
    path.write_text(token)
    os.chmod(path, 0o600)
    return token


def state_text(text: str, page) -> str:
    lines = [f"User request: {text}"]
    if page:
        lines.append(
            f"Open page: {page.get('host', '?')} · has search: {bool(page.get('canSearch'))}"
            f" · results shown: {int(page.get('resultCount', 0))}"
        )
    else:
        lines.append("Open page: none")
    return "\n".join(lines)


class Laya:
    """The warm model. Loaded once at start-up."""

    def __init__(self):
        self.mode = "fake" if FAKE else "laya"
        self.agent = None
        if not FAKE:
            import laya_mlx  # noqa: PLC0415 — only in the Apple Silicon environment

            dtype = os.environ.get("TECHIE_MIND_LAYA_DTYPE", "float16")
            self.agent = laya_mlx.load(MODEL, dtype=dtype)

    def raw(self, text: str, page, choices):
        options = [DESCRIPTIONS.get(c, c) for c in choices]
        questions = {"category": {"question": QUESTION, "options": options}}
        return self.agent.predict(state_text(text, page), questions)

    def classify(self, text: str, page, choices):
        if FAKE:
            return fake_classify(text, page, choices)
        result = self.raw(text, page, choices)
        return interpret(result, choices)


def interpret(result, choices):
    """Map Laya's answer for the "category" question onto one of `choices`. Defensive: any shape
    we do not recognise becomes an escalation — never a guess."""
    answer = result
    if isinstance(result, dict):
        answer = result.get("answers", result)
        if isinstance(answer, dict):
            answer = answer.get("category", answer)
    options = [DESCRIPTIONS.get(c, c) for c in choices]
    choice, confidence, escalate = None, 0.0, False
    if isinstance(answer, dict):
        choice = answer.get("choice", answer.get("answer", answer.get("label")))
        confidence = answer.get("confidence", answer.get("prob", answer.get("score", 0.0)))
        act = str(answer.get("act", answer.get("action", ""))).lower()
        escalate = bool(answer.get("escalate")) or act == "escalate"
        if choice is None and isinstance(answer.get("probs"), dict):
            probs = answer["probs"]
            choice = max(probs, key=probs.get)
            confidence = probs[choice]
    elif isinstance(answer, str):
        choice, confidence = answer, 0.5
    if isinstance(choice, int) and 0 <= choice < len(choices):
        choice = choices[choice]
    if isinstance(choice, str) and choice in options:
        choice = choices[options.index(choice)]
    if choice not in choices:
        return {"category": "unclear", "confidence": 0.0, "escalate": True}
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.0
    return {"category": choice, "confidence": confidence, "escalate": escalate}


def fake_classify(text: str, page, choices):
    """Rule-based stand-in used only by automated tests (TECHIE_MIND_LAYA_FAKE=1)."""
    t = text.lower()
    if any(w in t for w in ("scroll", "zoom", "go back", "bigger", "smaller")):
        category, confidence = "page_command", 0.9
    elif any(w in t for w in (" one", "these", "those")):
        category, confidence = "pick_result", 0.45
    elif any(w in t for w in ("listen", "hear", "watch", "song", "music")):
        category, confidence = "play_media", 0.6
    else:
        category, confidence = "search", 0.9
    if category not in choices:
        category = "unclear"
    return {"category": category, "confidence": confidence, "escalate": confidence < 0.75}


class Handler(BaseHTTPRequestHandler):
    laya: "Laya" = None  # set at start-up
    token = ""

    def log_message(self, *args):  # no request logging: requests may contain user words
        pass

    def _send(self, status: int, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin", "")
        if origin.startswith(("chrome-extension://", "moz-extension://")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        origin = self.headers.get("Origin", "")
        if origin.startswith(("chrome-extension://", "moz-extension://")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", f"content-type, {TOKEN_HEADER}")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        return self._send(200, {"ok": True, "model": MODEL, "warm": True, "mode": self.laya.mode})

    def do_POST(self):
        if self.path != "/v1/classify":
            return self._send(404, {"error": "not found"})
        if not secrets.compare_digest(self.headers.get(TOKEN_HEADER, ""), self.token):
            return self._send(401, {"error": "bad token"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BYTES:
            return self._send(413, {"error": f"body must be 1..{MAX_BYTES} bytes"})
        try:
            payload = json.loads(self.rfile.read(length))
            text = payload["text"]
            page = payload.get("page")
            choices = payload.get("choices") or CATEGORIES
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                raise ValueError("text")
            if page is not None and not isinstance(page, dict):
                raise ValueError("page")
            if not isinstance(choices, list) or any(c not in CATEGORIES for c in choices):
                raise ValueError("choices")
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            return self._send(400, {"error": f"invalid request ({error})"})
        started = time.perf_counter()
        try:
            answer = self.laya.classify(text, page, choices)
        except Exception as error:  # noqa: BLE001 — answer with an escalation, never crash
            return self._send(500, {"error": type(error).__name__})
        answer["model"] = MODEL if self.laya.mode == "laya" else "fake-laya"
        answer["latencyMs"] = round((time.perf_counter() - started) * 1000, 2)
        return self._send(200, answer)


def selftest(laya: "Laya"):
    samples = [
        ("iphone 15", {"host": "www.flipkart.com", "canSearch": True, "resultCount": 20}),
        ("open the samsung one", {"host": "www.flipkart.com", "canSearch": True, "resultCount": 20}),
        ("I want to hear something by Arijit Singh", None),
        ("scroll down a bit", {"host": "www.youtube.com", "canSearch": True, "resultCount": 0}),
    ]
    for text, page in samples:
        started = time.perf_counter()
        raw = laya.raw(text, page, CATEGORIES) if laya.mode == "laya" else None
        answer = laya.classify(text, page, CATEGORIES)
        ms = (time.perf_counter() - started) * 1000
        print(json.dumps({"text": text, "raw": repr(raw)[:400], "answer": answer, "ms": round(ms, 1)}))


def main():
    started = time.perf_counter()
    laya = Laya()
    if "--selftest" in sys.argv:
        return selftest(laya)
    Handler.laya = laya
    Handler.token = load_token()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"laya adapter ready on http://{HOST}:{PORT} ({laya.mode}, loaded in "
        f"{time.perf_counter() - started:.1f}s). Token file: ~/.config/techie-mind/laya.token "
        "(or TECHIE_MIND_LAYA_TOKEN) — paste it into Techie Mind Settings → AI Models → Laya.",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
