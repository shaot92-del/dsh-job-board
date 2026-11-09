#!/usr/bin/env python3
"""board_server.py 契约 smoke（v1.3.10）。

覆盖两件只在真板子上才看得出来的事：
  F1  同一个端口、不同 --state 起第二个实例必须拒绝绑定（Windows 上 SO_REUSEADDR
      曾经允许两个进程同时 listen，两边各持一份内存态互相覆盖）。
  F3  机器名大小写不敏感：GT14 认领的任务，gt14 也能 beat / mark / release
      （以前 mark/release 裸比较，`gt14` 永远 409，客户端再也更新不了自己的任务）。

用法：
    python scripts/board-server-smoke.py
    GP_BOARD_SERVER=/path/to/board_server.py python scripts/board-server-smoke.py

没有板子脚本时（例如 CI 的 Linux runner）直接跳过并以 0 退出。
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SERVER = os.environ.get("GP_BOARD_SERVER", r"L:\云盘\gp_video_xfer\_tools\board_server.py")
TOKEN = "smoke-" + os.urandom(8).hex()
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (("  " + detail) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def call(port: int, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), data=data, method="POST" if data is not None else "GET"
    )
    req.add_header("x-board-token", TOKEN)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start(state: str, port: int) -> subprocess.Popen:
    env = dict(os.environ, GP_BOARD_TOKENS=TOKEN, PYTHONIOENCODING="utf-8")
    return subprocess.Popen(
        [sys.executable, SERVER, "--bind", "127.0.0.1", "--port", str(port), "--state", state],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def wait_health(port: int, timeout: float = 12.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            code, body = call(port, "/api/health")
            if code == 200 and body.get("ok"):
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


def main() -> int:
    if not os.path.isfile(SERVER):
        print("SKIP 找不到板子脚本：%s" % SERVER)
        return 0

    tmp = tempfile.mkdtemp(prefix="board-smoke-")
    port = free_port()
    p1 = start(os.path.join(tmp, "a", "state.json"), port)
    try:
        check("F1 第一实例启动并健康", wait_health(port), "port=%d" % port)

        tid = "smoke-" + os.urandom(4).hex()
        code, body = call(
            port, "/api/create", {"task_id": tid, "title": "smoke", "goal": "echo hi", "machine": "GT14"}
        )
        check("建单成功", code == 200 and bool(tid), "%s %s" % (code, body))

        code, body = call(port, "/api/claim", {"task_id": tid, "machine": "GT14", "minutes": 5})
        check("F3 用 GT14 认领", code == 200, "%s %s" % (code, body))

        code, body = call(port, "/api/beat", {"task_id": tid, "machine": "gt14", "minutes": 5})
        check("F3 gt14 心跳不再 409", code == 200, "%s %s" % (code, body))

        code, body = call(port, "/api/mark", {"task_id": tid, "machine": "gt14", "note": "case-insensitive"})
        check("F3 gt14 可以改写自己的任务", code == 200, "%s %s" % (code, body))

        code, body = call(port, "/api/mark", {"task_id": tid, "machine": "MB14", "note": "not yours"})
        check("F3 别的机器仍然 409", code == 409, "%s %s" % (code, body))

        code, body = call(port, "/api/release", {"task_id": tid, "machine": "gt14", "status": "done"})
        check("F3 gt14 可以交付", code == 200, "%s %s" % (code, body))

        # F1：同端口、不同 state 的第二实例必须拒绝绑定
        p2 = start(os.path.join(tmp, "b", "state.json"), port)
        try:
            rc = p2.wait(timeout=8)
        except subprocess.TimeoutExpired:
            rc = None
        err = (p2.stderr.read() or b"").decode("utf-8", "replace") if p2.stderr else ""
        if rc is None:
            p2.kill()
        check("F1 第二实例拒绝启动", rc not in (0, None), "rc=%s" % rc)
        check("F1 失败原因写清了", "绑定" in err or "占用" in err, err.strip()[:160])
    finally:
        for proc in (p1,):
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    print("\n%d 项失败" % len(FAILS) if FAILS else "\n全部通过")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
