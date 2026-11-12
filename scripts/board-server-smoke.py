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

默认用仓库内的 tools/board_server.py（v1.4.0 起随包发布）；找不到时才跳过并以 0 退出。
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

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_SERVER = os.path.join(os.path.dirname(_HERE), "tools", "board_server.py")
SERVER = os.environ.get("GP_BOARD_SERVER") or _REPO_SERVER
TOKEN = "smoke-" + os.urandom(8).hex()
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (("  " + detail) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def call(port: int, path: str, body: dict | None = None, host: str = "127.0.0.1",
         token: str | None = TOKEN) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        "http://%s:%d%s" % (host, port, path), data=data, method="POST" if data is not None else "GET"
    )
    if token:
        req.add_header("x-board-token", token)
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


def lan_ip() -> str:
    """取本机对外 IPv4（连 UDP 不真正发包）；拿不到返回空串。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        return "" if ip.startswith("127.") else ip
    except Exception:
        return ""


def start(state: str, port: int, bind: str = "127.0.0.1", env_extra: dict | None = None) -> subprocess.Popen:
    env = dict(os.environ, GP_BOARD_TOKENS=TOKEN, PYTHONIOENCODING="utf-8")
    if env_extra:
        env.update(env_extra)
    return subprocess.Popen(
        [sys.executable, SERVER, "--bind", bind, "--port", str(port), "--state", state],
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
    p1 = start(os.path.join(tmp, "a", "state.json"), port, bind="0.0.0.0")
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

        # M1（v1.3.11）：非回环客户端改状态必须带 machine/holder，不能靠省略字段绕过
        lan = lan_ip()
        if lan:
            code, body = call(port, "/api/health", token=None, host=lan)
            check("L1 无 token 的 health 只有 ok", code == 200 and set(body.keys()) == {"ok"},
                  "%s %s" % (code, body))
            tid2 = "m1-" + os.urandom(4).hex()
            call(port, "/api/create", {"task_id": tid2, "title": "m1", "goal": "echo hi", "machine": "GT14"})
            call(port, "/api/claim", {"task_id": tid2, "machine": "GT14", "minutes": 5})
            code, body = call(port, "/api/mark", {"task_id": tid2, "note": "no identity"}, host=lan)
            check("M1 局域网匿名 mark 被拒（400）", code == 400 and body.get("error") == "identity-required",
                  "%s %s" % (code, body))
            code, body = call(port, "/api/mark",
                              {"task_id": tid2, "machine": "GT14", "note": "with identity"}, host=lan)
            check("M1 带 machine 的 mark 仍然放行", code == 200, "%s %s" % (code, body))
            code, body = call(port, "/api/release", {"task_id": tid2, "status": "done"}, host=lan)
            check("M1 局域网匿名 release 被拒（400）", code == 400 and body.get("error") == "identity-required",
                  "%s %s" % (code, body))
            code, body = call(port, "/api/release", {"task_id": tid2, "machine": "GT14", "status": "done"}, host=lan)
            check("M1 带 machine 的 release 放行", code == 200, "%s %s" % (code, body))
        else:
            print("SKIP 找不到非回环 IPv4，跳过 M1 局域网用例")

        # R21 的板子侧语义（v1.5.3）：同机不同实例（holder 不同）再 take 必须 409，
        # 否则同一条任务会被两个 DSH 进程各派一遍。
        tid3 = "hold-" + os.urandom(4).hex()
        call(port, "/api/create", {"task_id": tid3, "title": "holder", "goal": "echo hi",
                                   "dispatch": "auto", "machine": "GT14"})
        code, body = call(port, "/api/take",
                          {"task_id": tid3, "machine": "GT14", "holder": "inst-a", "minutes": 5})
        check("同机实例 A 认领成功", code == 200, "%s %s" % (code, body))
        code, body = call(port, "/api/take",
                          {"task_id": tid3, "machine": "GT14", "holder": "inst-b", "minutes": 5})
        check("同机实例 B 被 holder 挡住（409）", code == 409 and "另一个实例" in str(body.get("error", "")),
              "%s %s" % (code, body))
        code, body = call(port, "/api/release",
                          {"task_id": tid3, "machine": "GT14", "holder": "inst-a", "status": "done"})
        check("实例 A 可以交付", code == 200, "%s %s" % (code, body))

        # L2（v1.3.11）：caps / metrics / seed 都有大小上限
        big = "x" * (9 * 1024)
        code, body = call(port, "/api/caps", {"machine": "GT14", "caps": {"blob": big}})
        check("L2 超大 caps 被拒（413）", code == 413, "%s %s" % (code, body))
        code, body = call(port, "/api/metrics", {"machine": "GT14", "live": {"blob": "y" * (5 * 1024)}})
        check("L2 超大 metrics 被拒（413）", code == 413, "%s %s" % (code, body))
        code, body = call(port, "/api/seed", {"tasks": [{"taskId": "z%d" % i, "goal": "g"} for i in range(250)]})
        check("L2 超量 seed 被拒（413）", code == 413, "%s %s" % (code, body))

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

        # P2-14（v2.0.6）：同一份 state、换一个端口，也必须只有一个写入者
        p3 = start(os.path.join(tmp, "a", "state.json"), free_port())
        try:
            rc3 = p3.wait(timeout=8)
        except subprocess.TimeoutExpired:
            rc3 = None
        err3 = (p3.stderr.read() or b"").decode("utf-8", "replace") if p3.stderr else ""
        if rc3 is None:
            p3.kill()
        check("P2-14 同 state 不同端口拒绝启动", rc3 not in (0, None), "rc=%s" % rc3)
        check("P2-14 说明了是同一份 state", "已有板子在跑" in err3, err3.strip()[:160])

        # P2-15（v2.0.6）：create 与 claim 都要吃总数上限，不能只卡 seed
        p4_port = free_port()
        p4 = start(os.path.join(tmp, "c", "state.json"), p4_port, env_extra={"GP_BOARD_MAX_TASKS": "2"})
        try:
            check("P2-15 限额实例启动", wait_health(p4_port))
            c1, _ = call(p4_port, "/api/create", {"task_id": "cap-1", "goal": "g1"})
            c2, _ = call(p4_port, "/api/create", {"task_id": "cap-2", "goal": "g2"})
            c3, b3 = call(p4_port, "/api/create", {"task_id": "cap-3", "goal": "g3"})
            check("P2-15 前两条可以建", c1 == 200 and c2 == 200, "%s %s" % (c1, c2))
            check("P2-15 第三条 create 被拒（413）", c3 == 413, "%s %s" % (c3, b3))
            c4, b4 = call(p4_port, "/api/claim", {"task_id": "cap-4", "machine": "GT14"})
            check("P2-15 未知任务 claim 也被拒（413）", c4 == 413, "%s %s" % (c4, b4))
        finally:
            p4.terminate()
            try:
                p4.wait(timeout=5)
            except Exception:
                p4.kill()

        # P2-16（v2.0.7）：终态任务不修剪时，MAX_TASKS 实际是"历史总量"上限，
        # 跑到 5000 之后新任务永远建不出来。这里预置 3 条 40 天前的 done，
        # 上限设 2 —— 容量检查前必须先 prune，否则 create 必 413。
        p5_port = free_port()
        p5_state = os.path.join(tmp, "d", "state.json")
        os.makedirs(os.path.dirname(p5_state), exist_ok=True)
        old_ts = time.time() - 40 * 24 * 3600
        with open(p5_state, "w", encoding="utf-8") as fh:
            json.dump({
                "updated": int(time.time()),
                "tasks": {
                    "old-1": {"status": "done", "updated_at": old_ts},
                    "old-2": {"status": "failed", "updated_at": old_ts},
                    "old-3": {"status": "superseded", "updated_at": old_ts},
                },
                "machines": {},
                "events": [],
            }, fh)
        p5 = start(p5_state, p5_port, env_extra={"GP_BOARD_MAX_TASKS": "2"})
        try:
            check("P2-16 修剪实例启动", wait_health(p5_port))
            c5, b5 = call(p5_port, "/api/create", {"task_id": "fresh-1", "goal": "g"})
            check("P2-16 过期终态被清后仍可建单", c5 == 200, "%s %s" % (c5, b5))
            gb, board = call(p5_port, "/api/board")
            tasks = (board or {}).get("tasks") or {}
            left = [k for k in ("old-1", "old-2", "old-3") if k in tasks]
            check("P2-16 40 天前的终态已清掉", not left, "left=%s" % left)
        finally:
            p5.terminate()
            try:
                p5.wait(timeout=5)
            except Exception:
                p5.kill()
        # B1（v2.1.0 复审）：显示名只当查找键，attach 落库必须是身份；未知显示名 400；alias 全局唯一
        p6_port = free_port()
        p6_state = os.path.join(tmp, "e", "state.json")
        os.makedirs(os.path.dirname(p6_state), exist_ok=True)
        p6 = start(p6_state, p6_port)
        try:
            check("B1 实例启动", wait_health(p6_port))
            c6, b6 = call(p6_port, "/api/caps", {"machine": "GT14", "caps": {"os": "windows", "alias": "GT14 工作机"}})
            check("B1 上报显示名", c6 == 200, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/caps", {"machine": "MB14", "caps": {"alias": "gt14 工作机"}})
            check("B1 caps 撞名只丢 alias（200）", c6 == 200, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/create", {"task_id": "b1-1", "goal": "g", "machine": "GT14"})
            check("B1 建单", c6 == 200, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/attach", {"task_id": "b1-1", "remote_id": "ui-b1", "machine": "GT14 工作机"})
            check("B1 attach 显示名折回身份", c6 == 200, "%s %s" % (c6, b6))
            _, board6 = call(p6_port, "/api/board")
            t6 = ((board6 or {}).get("tasks") or {}).get("b1-1") or {}
            check("B1 任务 machine 是身份", t6.get("machine") == "GT14", repr(t6.get("machine")))
            mach6 = (board6 or {}).get("machines") or {}
            check("B1 没有 ghost 机器", "GT14 工作机" not in mach6, ",".join(mach6.keys()))
            c6, b6 = call(p6_port, "/api/create", {"task_id": "b1-2", "goal": "g", "machine": "GT14"})
            check("B1 第二单", c6 == 200, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/attach", {"task_id": "b1-2", "remote_id": "ui-b1b", "machine": "GT14 工作机二"})
            check("B1 未知显示名 attach 被拒（400）", c6 == 400, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/caps", {"machine": "MB14", "caps": {"alias": "MB14 机"}})
            check("A1 第二台机器上报显示名", c6 == 200, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/alias", {"machine": "GT14", "alias": "GT14 新名字"})
            check("A1 看板改显示名（200）", c6 == 200 and b6.get("alias") == "GT14 新名字", "%s %s" % (c6, b6))
            _, board6 = call(p6_port, "/api/board")
            check("A1 快照出现新显示名", ((board6 or {}).get("machines") or {}).get("GT14", {}).get("caps", {}).get("alias") == "GT14 新名字", "")
            # A1b：机器自己的 caps 上报（空 alias）不能把看板侧改的名字洗掉
            c6, b6 = call(p6_port, "/api/caps", {"machine": "GT14", "caps": {"os": "windows"}})
            board6 = call(p6_port, "/api/board", token=TOKEN)[1]
            got = ((board6.get("machines") or {}).get("GT14", {}).get("caps", {}).get("alias") or "")
            check("A1b caps 不覆盖看板改名", c6 == 200 and got == "GT14 新名字", "%s %r" % (c6, got))
            # A1c：改名不算心跳（离线机器不会因为改名变在线）——用 force:"false" 字符串验证严格布尔
            c6, b6 = call(p6_port, "/api/forget-machine", {"machine": "GT14", "force": "false"})
            check("A1c force 字符串不生效（409）", c6 == 409, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/alias", {"machine": "MB14", "alias": "GT14 新名字"})
            check("A1 改显示名撞名被拒（409）", c6 == 409, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/forget-machine", {"machine": "MB14"})
            check("A2 在线机器移除需 force（409）", c6 == 409, "%s %s" % (c6, b6))
            c6, b6 = call(p6_port, "/api/forget-machine", {"machine": "MB14", "force": True})
            check("A2 force 移除在线机器（200）", c6 == 200, "%s %s" % (c6, b6))
            _, board6 = call(p6_port, "/api/board")
            check("A2 快照里已没有 MB14", "MB14" not in ((board6 or {}).get("machines") or {}), ",".join(((board6 or {}).get("machines") or {}).keys()))
        finally:
            p6.terminate()
            try:
                p6.wait(timeout=5)
            except Exception:
                p6.kill()

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
