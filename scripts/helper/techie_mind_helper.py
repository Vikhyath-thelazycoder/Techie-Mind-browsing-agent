#!/usr/bin/env python3
"""Techie Mind helper — lets the extension switch its local services on and off.

Chrome native messaging (one message in, one answer out, 4-byte length prefix + JSON). Chrome starts
this script only for the Techie Mind extension (see install.sh). It knows exactly two services and
three commands; it never runs anything the message names:

  {"cmd": "status" | "start" | "stop", "service": "laya" | "whisper"}
  -> {"ok": true, "service": ..., "running": bool, "message": str}

Started services run detached (their own session), so they keep running after this script exits,
until "stop" or a restart of the Mac. Nothing starts on its own.

Paths can be changed in ~/.config/techie-mind/helper.json:
  {"laya_python": "...", "whisper_dir": "...", "whisper_model": "models/ggml-small.bin"}
"""

import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
REPO = Path(__file__).resolve().parents[2]
STATE = HOME / ".config" / "techie-mind"
LOGS = HOME / "Library" / "Logs" / "techie-mind"


def config() -> dict:
    path = STATE / "helper.json"
    try:
        return json.loads(path.read_text()) if path.exists() else {}
    except (OSError, ValueError):
        return {}


def services() -> dict:
    c = config()
    whisper_dir = Path(c.get("whisper_dir", HOME / "Developer" / "whisper.cpp"))
    laya_python = c.get("laya_python", HOME / ".cache" / "techymind-laya" / "py311" / "bin" / "python")
    return {
        "laya": {
            "port": 8765,
            "cwd": REPO,
            "argv": [str(laya_python), str(REPO / "scripts" / "laya" / "laya_adapter.py")],
            "match": "laya_adapter.py",
            "boot_seconds": 90,
        },
        "whisper": {
            "port": 8178,
            "cwd": whisper_dir,
            "argv": [
                str(whisper_dir / "build" / "bin" / "whisper-server"),
                "-m",
                str(c.get("whisper_model", "models/ggml-small.bin")),
                "--host",
                "127.0.0.1",
                "--port",
                "8178",
                "--convert",
            ],
            "match": "whisper-server",
            "boot_seconds": 30,
        },
    }


def listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def pids(match: str) -> list:
    try:
        out = subprocess.run(
            ["pgrep", "-f", match], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(p) for p in out.split() if p.isdigit() and int(p) != os.getpid()]


def start(name: str, svc: dict) -> dict:
    if listening(svc["port"]):
        return {"running": True, "message": f"{name} is already running"}
    exe = Path(svc["argv"][0])
    if not exe.exists():
        return {"running": False, "message": f"{name} is not installed here: {exe}"}
    LOGS.mkdir(parents=True, exist_ok=True)
    log = open(LOGS / f"{name}.log", "ab")
    env = dict(os.environ)
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "/usr/bin:/bin")
    subprocess.Popen(
        svc["argv"],
        cwd=str(svc["cwd"]),
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        env=env,
        start_new_session=True,
    )
    deadline = time.time() + svc["boot_seconds"]
    while time.time() < deadline:
        if listening(svc["port"]):
            return {"running": True, "message": f"{name} started"}
        time.sleep(0.5)
    return {
        "running": False,
        "message": f"{name} is still starting (model loading); check again in a moment. Log: {LOGS / (name + '.log')}",
    }


def stop(name: str, svc: dict) -> dict:
    for pid in pids(svc["match"]):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    for _ in range(20):
        if not listening(svc["port"]):
            break
        time.sleep(0.25)
    running = listening(svc["port"])
    return {
        "running": running,
        "message": f"{name} stopped" if not running else f"{name} did not stop; quit it in Activity Monitor",
    }


def handle(message: dict) -> dict:
    name = message.get("service")
    cmd = message.get("cmd")
    table = services()
    if name not in table or cmd not in ("status", "start", "stop"):
        return {"ok": False, "message": "unknown command"}
    svc = table[name]
    if cmd == "status":
        running = listening(svc["port"])
        result = {"running": running, "message": f"{name} is {'running' if running else 'off'}"}
    elif cmd == "start":
        result = start(name, svc)
    else:
        result = stop(name, svc)
    return {"ok": True, "service": name, **result}


def main() -> None:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return
    (length,) = struct.unpack("<I", raw)
    if length > 4096:
        answer = {"ok": False, "message": "message too large"}
    else:
        try:
            answer = handle(json.loads(sys.stdin.buffer.read(length)))
        except (ValueError, TypeError):
            answer = {"ok": False, "message": "invalid message"}
    data = json.dumps(answer).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
