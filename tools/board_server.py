#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
作业板（board）· 四台 DSH 的共享现场

跑在主机上，四台机器通过 HTTP 读写同一份状态：
  GET  /                 浏览器仪表盘（5 秒自动刷新）
  GET  /api/board        当前全场状态 JSON
  POST /api/claim        认领一道工序（原子，撞车返回 409）
  POST /api/beat         心跳/续租（每 10 分钟一次）
  POST /api/release      交活：done / blocked / failed / queued
  POST /api/say          广播一句话（"我在传大文件，别抢带宽"）
  POST /api/seed         从工序清单导入 task_id（只补缺失的，不动已有的）

启动：
  python board_server.py --port 8965
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import html
import json
import os
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

STATE_LOCK = threading.RLock()
STATE = {
    "updated": 0,
    "tasks": {},
    "machines": {},
    "events": [],
}
STATE_PATH = ""
RECONCILE_ERROR = ""  # 最近一次 reconcile 扫描失败的原因（health 里回显）


def _build_id() -> str:
    """进程实际在跑的这份代码的指纹（health 回显，部署后用来确认不是旧进程）。"""
    try:
        with open(__file__, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except Exception:
        return ""


BUILD = _build_id()
DEFAULT_MINUTES = 30
STALE_GRACE = 120  # 租期过期后宽限秒数
ONLINE_WINDOW = 1200  # 20 分钟内有动静就算在线。心跳来自 dsh-team 插件（remoteSyncMs=6s 上报），不是计划任务 gp_presence —— 那个任务从来没装过（复核 F10）；20 分钟 = 连漏很多次才判离线
MAX_BODY_BYTES = 1024 * 1024  # 请求体上限：超过直接拒绝，避免半开连接/超大 body 打满线程
MAX_CAPS_BYTES = 8 * 1024     # v1.3.11（L2）：caps 对象上限
MAX_METRICS_BYTES = 4 * 1024  # v1.3.11（L2）：metrics live 对象上限
MAX_SEED_ITEMS = 200          # v1.3.11（L2）：一次最多导入多少条
MAX_TASKS = int(os.environ.get("GP_BOARD_MAX_TASKS") or 5000)  # v1.3.11（L2）：总数上限；环境变量供测试覆盖
MINUTES_MIN, MINUTES_MAX = 1, 1440  # 租约分钟数收敛到 1–1440，负数会让任务立刻过期

# ---------------------------------------------------------------- 秘密脱敏
# v3.2（安全审计 C1）：远端日志是不可信输入，板子把它拼进 note、再经 /api/board 广播，
# 于是任何一次把令牌打进 stdout 的运维动作都会在 15 秒内变成"公开发布"。
# 入站（写 note）与出口（序列化）各过一遍同样的过滤器。
_SECRET_RULES = [
    re.compile(r"nt_[0-9a-fA-F]{32}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"AQ\.[A-Za-z0-9_\-]{30,}"),
    re.compile(r"(?<![0-9a-zA-Z])[0-9a-fA-F]{40}(?![0-9a-zA-Z])"),
    re.compile(r"(?i)\b(x-board-token|nodetoken|node_token|access_token|api[_-]?key)\b\s*[:=]\s*['\"]?[^\s'\"]+"),
]


def redact(text):
    if not isinstance(text, str) or not text:
        return text
    out = text
    for pat in _SECRET_RULES:
        out = pat.sub("<redacted>", out)
    return out


def redact_obj(obj):
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, list):
        return [redact_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: redact_obj(v) for k, v in obj.items()}
    return obj


# ---------------------------------------------------------------- 状态持久化
def now() -> int:
    return int(time.time())

def _txt(value, limit: int = 0) -> str:
    """写入边界脱敏：落盘前就把令牌类内容换成 <redacted>，不要等到出口。

    v3.2（安全审计 C1）：只做出口红act 会把明文留在 state.json / 远端日志里，
    这些文件还会被镜像同步出去。
    """
    out = redact(str(value or ""))
    return out[:limit] if limit else out




def _minutes(body: dict, default: int) -> int:
    """租约分钟数收敛：非数字/负数/超大值一律夹到 [1, 1440]。

    v3.2（安全审计 M3）：以前负数会让任务立刻过期、超大值等于永久占用、非数字直接把
    异常回显成 500。
    """
    try:
        n = int(body.get("minutes") or default)
    except Exception:
        n = default
    return max(MINUTES_MIN, min(MINUTES_MAX, n))


def load_state() -> None:
    global STATE
    if STATE_PATH and os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as f:
                STATE = json.load(f)
        except Exception:
            pass
    STATE.setdefault("tasks", {})
    STATE.setdefault("machines", {})
    STATE.setdefault("events", [])
    if migrate_machines():
        save_state()


def save_state() -> None:
    if not STATE_PATH:
        return
    STATE["updated"] = now()
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(STATE, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_PATH)


def add_event(kind: str, machine: str = "", task: str = "", text: str = "") -> None:
    STATE["events"].append({"t": now(), "kind": kind, "machine": machine, "task": task, "text": text})
    STATE["events"] = STATE["events"][-200:]


# ---------------------------------------------------------------- 机器名归一
# 老脚本（board-presence.ps1 不带 -Machine 时）直接拿 $env:COMPUTERNAME 上报，
# 于是 MB14 在板上多出一条 desktop2gh05s7：一台机器两个身份，心跳各算各的。
# 这里按 hostname 把别名折回规范名，历史数据在启动时迁移一次。
MACHINE_ALIASES = {
    "desktopnj6ng3v": "host",
    "desktop2gh05s7": "MB14",
    "desktopj1ip3of": "PC2",
}


def _norm_machine(name) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name or "").lower())


def migrate_machines() -> bool:
    """把别名机器合并进规范名；返回是否有改动。"""
    changed = False
    old = STATE.get("machines") or {}
    merged: dict = {}
    for name, rec in old.items():
        canon = MACHINE_ALIASES.get(_norm_machine(name), name)
        if canon != name:
            changed = True
        rec = dict(rec or {})
        if canon in merged:
            prev = merged[canon]
            keep, other = (rec, prev) if int(rec.get("last_seen", 0)) >= int(prev.get("last_seen", 0)) else (prev, rec)
            combo = dict(other)
            combo.update({k: v for k, v in keep.items() if v not in (None, "", {}, [])})
            merged[canon] = combo
            changed = True
        else:
            merged[canon] = rec
    if changed:
        STATE["machines"] = merged
    for t in (STATE.get("tasks") or {}).values():
        m = t.get("machine")
        if m:
            canon = MACHINE_ALIASES.get(_norm_machine(m))
            if canon and canon != m:
                t["machine"] = canon
                changed = True
    return changed


def _canon_machine(name: str) -> str:
    """大小写不同视为同一台机器，复用已存在的写法（防止 gt14/GT14 分裂）"""
    if not name:
        return name
    alias = MACHINE_ALIASES.get(_norm_machine(name))
    if alias:
        return alias
    for k in STATE["machines"]:
        if k.lower() == name.lower():
            return k
    return name


def touch_machine(machine: str, current: str = "", note: str = "") -> None:
    machine = _canon_machine(machine)
    m = STATE["machines"].get(machine) or {}
    if current:
        m["current"] = current
    if note:
        m["note"] = note
    m["last_seen"] = now()
    STATE["machines"][machine] = m


def is_online(m: dict) -> bool:
    return bool(m) and (now() - int(m.get("last_seen", 0)) <= ONLINE_WINDOW)


def effective_task(t: dict) -> dict:
    """把租期过期的 claimed 标成 stale（只在读的时候算，不改盘）"""
    t = dict(t)
    if t.get("status") in ("claimed", "running"):
        if now() > int(t.get("lease_until", 0)) + STALE_GRACE:
            t["status"] = "stale"
    return t


def board_snapshot() -> dict:
    with STATE_LOCK:
        tasks = {k: effective_task(v) for k, v in STATE["tasks"].items()}
        machines = {}
        for name, m in STATE["machines"].items():
            machines[name] = {
                "online": is_online(m),
                "current": m.get("current", ""),
                "note": m.get("note", ""),
                "last_seen": m.get("last_seen", 0),
                "caps": m.get("caps"),
                "caps_at": m.get("caps_at", 0),
                "live": m.get("live"),
                "live_at": m.get("live_at", 0),
            }
        return {
            "now": now(),
            "updated": STATE.get("updated", 0),
            "machines": machines,
            "tasks": tasks,
            "events": STATE["events"][-30:],
            "counts": {
                s: sum(1 for t in tasks.values() if t.get("status") == s)
                for s in ("queued", "claimed", "running", "done", "blocked", "failed", "stale", "superseded")
            },
        }


# ---------------------------------------------------------------- 动作
def do_claim(body: dict) -> tuple[int, dict]:
    task_id = (body.get("task_id") or "").strip()
    machine = (body.get("machine") or "").strip()
    agent = (body.get("agent") or "").strip()
    note = _txt((body.get("note") or "").strip(), 300)
    minutes = _minutes(body, DEFAULT_MINUTES)
    if not task_id or not machine:
        return 400, {"error": "task_id 和 machine 必填"}

    with STATE_LOCK:
        t = STATE["tasks"].get(task_id) or {"status": "queued", "note": ""}
        eff = effective_task(t)
        holder = t.get("machine", "")
        if eff["status"] in ("claimed", "running") and holder and holder != machine:
            return 409, {
                "error": "已被占用",
                "task_id": task_id,
                "holder": holder,
                "lease_until": t.get("lease_until", 0),
                "note": t.get("note", ""),
            }
        if eff["status"] in ("done", "superseded"):
            return 409, {"error": "已完成" if eff["status"] == "done" else "已作废", "task_id": task_id}

        took_over = eff["status"] == "stale"
        # 复核（v2.0.6，P2-15）：未知任务可以自动建单，但也必须受总数上限约束。
        if task_id not in STATE["tasks"] and len(STATE["tasks"]) >= MAX_TASKS:
            return 413, {"error": "板子任务数到上限", "limit": MAX_TASKS}
        # 2026-10-31：改成**原地合并**。旧实现整条 dict 覆盖，认领会把
        # goal/title/mode/remote_id/dispatch 全抹掉，Host 侧统一派工没法用
        # claim 占位（复核报告 #6 的前置条件）。
        t = STATE["tasks"].setdefault(task_id, {"status": "queued"})
        t["status"] = "claimed"
        t["machine"] = machine
        t["owner"] = machine
        if agent:
            t["agent"] = agent
        if note:
            t["note"] = note
        t["claimed_at"] = now()
        t["lease_until"] = now() + minutes * 60
        t["updated_at"] = now()
        t.setdefault("progress", "")
        t.setdefault("artifact", "")
        t.pop("taker", None)
        if took_over:
            t["progress"] = ""
            t["artifact"] = ""
        touch_machine(machine, current=task_id)
        add_event("claim", machine, task_id, ("接管过期任务；" if took_over else "") + note)
        save_state()
        return 200, {"ok": True, "task_id": task_id, "lease_until": now() + minutes * 60}



def do_create(body: dict) -> tuple[int, dict]:
    """建一条板子任务（主控对话自动派工时用）。"""
    task_id = (body.get("task_id") or "").strip()
    goal = _txt((body.get("goal") or "").strip(), 300)
    machine = (body.get("machine") or "").strip()
    title = (body.get("title") or "").strip()[:120]
    note = _txt((body.get("note") or "").strip(), 500)
    dispatch = (body.get("dispatch") or "").strip()[:20]
    task_mode = (body.get("mode") or "").strip()[:10]
    workspace = (body.get("workspace") or "").strip()[:300]
    if not task_id:
        return 400, {"error": "task_id 必填"}
    if not goal:
        return 400, {"error": "goal 必填"}
    with STATE_LOCK:
        if task_id in STATE["tasks"]:
            return 409, {"error": "task_id 已存在", "task_id": task_id}
        # 复核（v2.0.6，P2-15）：容量检查以前只在 seed，create/claim 都能绕过。
        if len(STATE["tasks"]) >= MAX_TASKS:
            return 413, {"error": "板子任务数到上限", "limit": MAX_TASKS}
        STATE["tasks"][task_id] = {
            "status": "queued",
            "machine": machine,
            "owner": machine,
            "agent": "board_dispatch",
            "title": title or goal[:60],
            "goal": goal,
            "note": note,
            "dispatch": dispatch,
            "mode": task_mode,
            "workspace": workspace,
            "claimed_at": 0,
            "lease_until": 0,
            "updated_at": now(),
            "progress": "",
            "artifact": "",
            "remote_id": "",
        }
        add_event("create", machine or "host", task_id, (title or goal)[:120])
        save_state()
    return 200, {"ok": True, "task_id": task_id, "status": "queued"}


def do_attach(body: dict) -> tuple[int, dict]:
    """把远程任务号挂到板子任务上，状态转 running。"""
    task_id = (body.get("task_id") or "").strip()
    remote_id = (body.get("remote_id") or "").strip()[:120]
    machine = (body.get("machine") or "").strip()
    minutes = _minutes(body, 240)
    if not task_id:
        return 400, {"error": "task_id 必填"}
    with STATE_LOCK:
        t = STATE["tasks"].get(task_id)
        if not t:
            return 404, {"error": "没有这道任务", "task_id": task_id}
        if machine:
            t["machine"] = machine
            t["owner"] = machine
        if remote_id:
            t["remote_id"] = remote_id
        if t.get("dispatch"):
            t.pop("dispatch", None)  # 已接手，别再重复派
        t.pop("taker", None)
        t.pop("holder", None)  # v1.3.3：占位结束，实例身份随之清掉
        t["status"] = "running"
        t["claimed_at"] = now()
        t["lease_until"] = now() + minutes * 60
        t["updated_at"] = now()
        touch_machine(machine or t.get("machine") or "host", current=task_id)
        add_event("attach", machine or t.get("machine") or "host", task_id, remote_id)
        save_state()
    return 200, {"ok": True, "task_id": task_id, "remote_id": remote_id, "status": "running"}


def do_take(body: dict) -> tuple[int, dict]:
    """Host 调度器原子占位：只接受 dispatch=auto 的排队任务。

    这是"派发权"的守门人 —— 多台主控同时抢同一道任务，只有一个能拿到。
    拿到后任务进入 claimed + taker=<调度器机器>，机器的 machine 字段仍指向
    真正的执行机（不被调度器覆盖）。派出成功后再 attach 绑定 remote_id。
    """
    task_id = (body.get("task_id") or "").strip()
    machine = (body.get("machine") or "").strip()
    minutes = _minutes(body, 5)
    # v1.3.3：实例身份。同一台机器上可能同时跑两个 DSH 进程（两个 profile / 热重载残留），
    # 它们的 machine 名完全一样，只看 machine 会把"别人的占位"当成自己的重入。
    # 旧版插件不带 holder，此时保持原行为（兼容升级期）。
    holder = (body.get("holder") or "").strip()[:120]
    if not task_id or not machine:
        return 400, {"error": "task_id 和 machine 必填"}
    with STATE_LOCK:
        t = STATE["tasks"].get(task_id)
        if not t:
            return 404, {"error": "没有这道任务", "task_id": task_id}
        st = effective_task(t).get("status", "")
        disp = (t.get("dispatch") or "").strip()
        taker = (t.get("taker") or "").strip()
        if st in ("done", "superseded", "failed", "blocked"):
            return 409, {"error": "任务已结束", "status": st}
        if disp != "auto":
            return 409, {"error": "不是自动派发任务", "dispatch": disp}
        if st == "claimed":
            if taker == machine:
                # v1.3.3：同机第二个实例不能把别人的占位当"自己重入"—— 否则两边都会
                # 往下 /dispatch，同一条板上任务在副机上被派两遍。
                cur_holder = (t.get("holder") or "").strip()
                if cur_holder and holder and cur_holder != holder:
                    return 409, {"error": "已被同机的另一个实例占住",
                                 "taker": taker, "holder": cur_holder}
                if holder:
                    t["holder"] = holder
                t["lease_until"] = now() + minutes * 60
                t["updated_at"] = now()
                save_state()
                return 200, {"ok": True, "task_id": task_id, "taken": True,
                             "reentrant": True, "task": dict(t)}
            if taker:
                return 409, {"error": "已被别的调度器占住", "taker": taker}
            if (t.get("remote_id") or "").strip():
                return 409, {"error": "已派出，避免重复派"}
            if now() <= int(t.get("lease_until", 0)) + STALE_GRACE:
                return 409, {"error": "占位未过期", "machine": t.get("machine", "")}
        elif st not in ("queued", "stale"):
            return 409, {"error": "状态不可派发", "status": st}
        t["status"] = "claimed"
        t["taker"] = machine
        if holder:
            t["holder"] = holder
        t["claimed_at"] = now()
        t["lease_until"] = now() + minutes * 60
        t["updated_at"] = now()
        add_event("take", machine, task_id, "调度器占位")
        save_state()
        return 200, {"ok": True, "task_id": task_id, "taken": True, "task": dict(t)}


def do_untake(body: dict) -> tuple[int, dict]:
    """派发失败时把占位还回队列（machine 指向的执行机保持不动）。"""
    task_id = (body.get("task_id") or "").strip()
    machine = (body.get("machine") or "").strip()
    note = _txt((body.get("note") or "").strip(), 200)
    holder = (body.get("holder") or "").strip()[:120]
    if not task_id or not machine:
        return 400, {"error": "task_id 和 machine 必填"}
    with STATE_LOCK:
        t = STATE["tasks"].get(task_id)
        if not t:
            return 404, {"error": "没有这道任务", "task_id": task_id}
        if (t.get("taker") or "") != machine:
            return 409, {"error": "不是你占的", "taker": t.get("taker", "")}
        # v3.1（安全复审 F5）：同机第二个实例不能把别人有效占位放回队列（会导致双跑）。
        cur_holder = (t.get("holder") or "").strip()
        if cur_holder and holder and cur_holder != holder:
            return 409, {"error": "已被同机的另一个实例占住", "holder": cur_holder}
        t.pop("taker", None)
        t.pop("holder", None)
        # v1.3.3（复核 F8）：退回队列却留着 remote_id 的话，所有 Host 的队列过滤
        # （`!t.remote`）都会跳过它 —— 任务永远派不出去，而板上看起来只是 queued。
        dropped_remote = (t.pop("remote_id", None) or "").strip()
        t["status"] = "queued"
        t["dispatch"] = "auto"
        t["claimed_at"] = 0
        t["lease_until"] = 0
        t["updated_at"] = now()
        add_event("untake", machine, task_id, note or "派发失败，退回队列")
        save_state()
        return 200, {"ok": True, "task_id": task_id, "status": "queued"}


def do_mark(body: dict) -> tuple[int, dict]:
    """把一条板子任务标成待派（dispatch=pending），或清掉标记。面板会自动接手。"""
    task_id = (body.get("task_id") or "").strip()
    dispatch = (body.get("dispatch") or "").strip()[:20]
    status = (body.get("status") or "").strip()
    # v3.1（安全复审 F7）：status 必须白名单，否则任意字符串都能把任务改成不可见状态。
    if status and status not in ("queued", "claimed", "running", "done", "failed",
                                 "blocked", "superseded", "stale"):
        return 400, {"error": "status 不在白名单", "status": status}
    # v3.2（三方复审 F1/F7）：mark 也能改 task 的归属状态（queued 会清 taker/holder），
    # 之前完全不校验 machine/holder —— 同机另一个实例、甚至另一台机器都能把别人的任务
    # 放回队列。只在**双方都提供**时才比较，保持升级期兼容（旧插件不带这两个字段）。
    machine = (body.get("machine") or "").strip()
    holder = (body.get("holder") or "").strip()[:120]
    client = (body.get("__client") or "").strip()
    is_local = client in ("127.0.0.1", "::1", "")
    with STATE_LOCK:
        t = STATE["tasks"].get(task_id)
        if not t:
            return 404, {"error": "没有这道任务", "task_id": task_id}
        # v1.3.11（复核 M1）：任务已有执行机时，必须由知道这台机器的调用方改状态。
        # 以前"双方都提供才比较"意味着省略字段就能绕过 —— 持 token 者可关掉任意任务。
        if t.get("machine") and not machine and not holder and not is_local:
            return 400, {"error": "identity-required",
                         "hint": "mark 必须带 machine（执行机）或 holder；本机回环调用可省略"}
        # v1.3.10（复核 F3）：两侧都规范化再比，gt14 / GT14 视为同一台。
        if machine and t.get("machine") and _canon_machine(machine) != _canon_machine(t.get("machine")):
            return 409, {"error": "不是你占的", "holder": t.get("machine")}
        cur_holder = (t.get("holder") or "").strip()
        if cur_holder and holder and cur_holder != holder:
            return 409, {"error": "已被同机的另一个实例占住", "holder": cur_holder}
        if dispatch:
            t["dispatch"] = dispatch
        else:
            t.pop("dispatch", None)
        if status:
            t["status"] = status
        if "remote_id" in body:
            rid = (body.get("remote_id") or "").strip()[:120]
            if rid:
                t["remote_id"] = rid
            else:
                # v3.1（安全复审 F8）：空串不是 pop —— 会把 running 任务从 reconcile 与
                # syncRemote 的视野里同时摘掉，结果"远端还在跑、板上没人管"。
                t.pop("remote_id", None)
        if "note" in body:
            t["note"] = _txt((body.get("note") or "").strip(), 500)
        if status == "queued":
            # v3.1（安全复审 F7）：回队列要和 untake 一样清干净，否则是
            # "queued 但 remote_id 还在"的僵尸：队列过滤跳过它、同步循环也不看它。
            t.pop("taker", None)
            t.pop("holder", None)
            t.pop("remote_id", None)
            t["dispatch"] = "auto"
            t["claimed_at"] = 0
            t["lease_until"] = 0
        t["updated_at"] = now()
        save_state()
    return 200, {"ok": True, "task_id": task_id, "dispatch": dispatch, "status": t.get("status")}


def do_beat(body: dict) -> tuple[int, dict]:
    task_id = (body.get("task_id") or "").strip()
    machine = (body.get("machine") or "").strip()
    minutes = _minutes(body, DEFAULT_MINUTES)
    with STATE_LOCK:
        t = STATE["tasks"].get(task_id)
        if not t:
            return 404, {"error": "没有这道任务", "task_id": task_id}
        if _canon_machine(t.get("machine") or "") != _canon_machine(machine):
            return 409, {"error": "不是你占的", "holder": t.get("machine", "")}
        t["lease_until"] = now() + minutes * 60
        t["updated_at"] = now()
        if t.get("status") == "claimed":
            t["status"] = "running"
        if body.get("progress"):
            t["progress"] = str(body["progress"])[:200]
        touch_machine(machine, current=task_id)
        save_state()
        return 200, {"ok": True, "lease_until": t["lease_until"]}


# ---------------- 远程任务回收：把副机跑完的结果写回板子 ----------------
# 起因（2026-10-28）：派工成功后，浏览器侧负责回写；一旦页面没开/没刷新，
# 板子就永远停在 running。这里改成板子自己盯着共享盘上的远程任务记录，
# 不依赖任何浏览器登录态。
RECONCILE_ROOT = os.environ.get("GP_REMOTE_LOGS", r"L:\云盘\gp_video_xfer\_remote-logs")
RECONCILE_SEC = int(os.environ.get("GP_RECONCILE_SEC", "15"))


def _read_json_quiet(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def reconcile_once() -> int:
    global RECONCILE_ERROR  # v1.3.10（F9）：声明必须在函数内任何读取之前
    with STATE_LOCK:
        pending = [(tid, dict(t)) for tid, t in STATE["tasks"].items()
                   if t.get("status") == "running" and (t.get("remote_id") or "").strip()]
    if not pending:
        return 0
    index = {}
    try:
        for mdir in os.listdir(RECONCILE_ROOT):
            tdir = os.path.join(RECONCILE_ROOT, mdir, "tasks")
            if not os.path.isdir(tdir):
                continue
            for fn in os.listdir(tdir):
                if fn.endswith(".json"):
                    index.setdefault(fn[:-5], os.path.join(tdir, fn))
    except Exception as e:  # v1.3.10（复核 F9）：以前这里静默 return 0，远端跑完的任务在板上永远 running
        msg = "%s: %s" % (type(e).__name__, e)
        if msg != RECONCILE_ERROR:
            RECONCILE_ERROR = msg
            try:
                print("[!] reconcile 扫描失败：%s" % msg, file=sys.stderr, flush=True)
            except Exception:
                pass
        return 0
    if RECONCILE_ERROR:
        RECONCILE_ERROR = ""  # 扫描恢复正常，清掉错误位
    changed = 0
    for tid, t in pending:
        rid = (t.get("remote_id") or "").strip()
        path = index.get(rid)
        if not path:
            continue
        rec = _read_json_quiet(path)
        if not isinstance(rec, dict):
            continue
        st = (rec.get("status") or "").strip()
        if st not in ("completed", "failed"):
            continue
        lines = []
        for item in (rec.get("logs") or [])[-4:]:
            line = (item.get("line") if isinstance(item, dict) else str(item)) or ""
            line = line.strip()
            if line:
                lines.append(line)
        note = redact(("远程 " + st) + ("：" + " / ".join(lines) if lines else ""))[:300]
        fin = "done" if st == "completed" else "failed"
        with STATE_LOCK:
            cur = STATE["tasks"].get(tid)
            if not cur:
                continue
            # 复核（v2.0.6，P1-4）：读日志到写回之间任务可能已被重排并绑定新的
            # remote_id（新的执行轮次）。只检查"任务还在"会把上一轮的旧结果写到
            # 新一轮上 —— 必须复核 remote_id 与 running 状态都没变。
            if (cur.get("remote_id") or "").strip() != rid or cur.get("status") != "running":
                continue
            cur["status"] = fin
            cur["note"] = note
            cur["updated_at"] = now()
            cur["lease_until"] = 0
            add_event(fin, cur.get("machine") or "", tid, note[:200])
            save_state()
        changed += 1
    return changed


def reconcile_loop() -> None:
    while True:
        try:
            n = reconcile_once()
            if n:
                print(f"[reconcile] 回写 {n} 条远程结果", flush=True)
        except Exception as exc:
            print(f"[reconcile] 出错 {exc}", flush=True)
        time.sleep(RECONCILE_SEC)


def do_metrics(body: dict) -> tuple[int, dict]:
    """节点实时指标（R4+）：内存占用/CPU/磁盘/负载，供看板显示。"""
    machine = (body.get("machine") or "").strip()
    live = body.get("live")
    if not machine or not isinstance(live, dict):
        return 400, {"error": "需要 machine 与 live（对象）"}
    if len(json.dumps(live, ensure_ascii=False).encode("utf-8")) > MAX_METRICS_BYTES:
        return 413, {"error": "live 太大", "limit": MAX_METRICS_BYTES}
    key = _canon_machine(machine)
    with STATE_LOCK:
        m = STATE["machines"].setdefault(key, {})
        m["live"] = live
        m["live_at"] = now()
        m["last_seen"] = now()
        STATE["updated"] = now()
        save_state()
    return 200, {"ok": True, "machine": key}


def do_caps(body: dict) -> tuple[int, dict]:
    """节点配置清单上报（R4）：每台机器开机/定时把自己的能力清单交上来。"""
    machine = (body.get("machine") or "").strip()
    caps = body.get("caps")
    if not machine or not isinstance(caps, dict):
        return 400, {"error": "需要 machine 与 caps（对象）"}
    if len(json.dumps(caps, ensure_ascii=False).encode("utf-8")) > MAX_CAPS_BYTES:
        return 413, {"error": "caps 太大", "limit": MAX_CAPS_BYTES}
    key = _canon_machine(machine)
    with STATE_LOCK:
        m = STATE["machines"].setdefault(key, {})
        merged = dict(m.get("caps") or {})
        merged.update(caps)
        # 合并后也要有上限：以前不停上报能把 state.json 撑大，读板子越来越慢。
        if len(json.dumps(merged, ensure_ascii=False).encode("utf-8")) > MAX_CAPS_BYTES * 2:
            merged = dict(caps)
        m["caps"] = merged
        m["caps_at"] = now()
        touch_machine(key)
        save_state()
    return 200, {"ok": True, "machine": key, "caps": merged, "caps_at": now()}

def do_release(body: dict) -> tuple[int, dict]:
    task_id = (body.get("task_id") or "").strip()
    machine = (body.get("machine") or "").strip()
    status = (body.get("status") or "done").strip()
    holder = (body.get("holder") or "").strip()[:120]
    if status not in ("done", "blocked", "failed", "queued", "superseded"):
        return 400, {"error": "status 只能 done/blocked/failed/queued/superseded"}
    if status == "superseded" and not (body.get("note") or "").strip():
        return 400, {"error": "作废必须写原因（note）"}
    with STATE_LOCK:
        t = STATE["tasks"].get(task_id)
        if not t:
            return 404, {"error": "没有这道任务", "task_id": task_id}
        # v1.3.10（复核 F3）：release 同样按规范化后的机器名比。
        # v1.3.11（复核 M1）：以前 machine 省略时整个条件短路成放行，等于任何持 token
        # 的人都能关掉任意任务。现在：带 machine 就必须对得上；不带就必须带 holder
        # 或来自本机回环（GUI/插件在同一台机上），否则拒绝。
        client = (body.get("__client") or "").strip()
        is_local = client in ("127.0.0.1", "::1", "")
        if t.get("machine"):
            if machine:
                if _canon_machine(t.get("machine")) != _canon_machine(machine):
                    return 409, {"error": "不是你占的", "holder": t.get("machine")}
            elif not holder and not is_local:
                return 400, {"error": "identity-required",
                             "hint": "release 必须带 machine（执行机）或 holder；本机回环调用可省略"}
        # v3.1（安全复审 F5）：holder 参与归属校验 —— 同机第二个实例不能把别人的占位放回队列。
        cur_holder = (t.get("holder") or "").strip()
        if cur_holder and holder and cur_holder != holder:
            return 409, {"error": "已被同机的另一个实例占住", "holder": cur_holder}
        t["status"] = status
        t["updated_at"] = now()
        t["lease_until"] = 0
        if status == "queued":
            # v3.1（安全复审 F6）：回队列必须同时恢复 dispatch=auto 并清掉 machine，
            # 否则任务会变成"queued 但谁都派不出去 / 谁都认领不了"（与 untake 对齐）。
            t.pop("remote_id", None)
            t.pop("taker", None)
            t.pop("holder", None)
            t.pop("machine", None)
            t["dispatch"] = "auto"
            t["claimed_at"] = 0
        t["note"] = _txt((body.get("note") or ""), 500)
        if body.get("artifact"):
            t["artifact"] = str(body["artifact"])[:300]
        touch_machine(machine)
        STATE["machines"].setdefault(_canon_machine(machine), {})["current"] = ""
        add_event(status, machine, task_id, t["note"])
        save_state()
        return 200, {"ok": True, "task_id": task_id, "status": status}


def do_seen(body: dict) -> tuple[int, dict]:
    """任何一次 status 都算一次报到，避免空闲机器被误判离线"""
    machine = (body.get("machine") or "").strip()
    if not machine:
        return 400, {"error": "machine 必填"}
    with STATE_LOCK:
        touch_machine(machine)
        save_state()
    return 200, {"ok": True}


def do_say(body: dict) -> tuple[int, dict]:
    machine = (body.get("machine") or "?").strip()
    text = _txt((body.get("text") or "").strip(), 300)
    with STATE_LOCK:
        touch_machine(machine)
        add_event("say", machine, "", text)
        save_state()
    return 200, {"ok": True}


def do_seed(body: dict) -> tuple[int, dict]:
    items = body.get("tasks") or []
    if not isinstance(items, list):
        return 400, {"error": "tasks 必须是数组"}
    if len(items) > MAX_SEED_ITEMS:
        return 413, {"error": "一次导入太多", "limit": MAX_SEED_ITEMS, "got": len(items)}
    added = 0
    with STATE_LOCK:
        for it in items:
            tid = (it.get("task_id") or "").strip() if isinstance(it, dict) else str(it).strip()
            if not tid:
                continue
            if tid not in STATE["tasks"]:
                if len(STATE["tasks"]) >= MAX_TASKS:
                    return 413, {"error": "板子任务数到上限", "limit": MAX_TASKS}
                STATE["tasks"][tid] = {
                    "status": "queued",
                    "machine": "",
                    "agent": "",
                    "note": "",
                    "goal": (it.get("goal") or "")[:300] if isinstance(it, dict) else "",
                    "owner": (it.get("machine") or "")[:20] if isinstance(it, dict) else "",
                    "claimed_at": 0,
                    "lease_until": 0,
                    "updated_at": now(),
                    "progress": "",
                    "artifact": "",
                }
                added += 1
        save_state()
    return 200, {"ok": True, "added": added, "total": len(STATE["tasks"])}


# ---------------------------------------------------------------- HTML
def human_age(ts: int) -> str:
    if not ts:
        return "-"
    d = max(0, now() - int(ts))
    if d < 60:
        return f"{d}秒前"
    if d < 3600:
        return f"{d // 60}分钟前"
    return f"{d // 3600}小时前"


def render_html(snap: dict) -> str:
    c = snap["counts"]
    rows = []
    for name in ("host", "GT14", "PC2", "MB14"):
        m = snap["machines"].get(name) or {}
        on = m.get("online")
        cur = m.get("current") or "空闲"
        rows.append(
            f"<tr><td>{html.escape(name)}</td><td class='{'on' if on else 'off'}'>"
            f"{'在线' if on else '离线'}</td><td>{html.escape(str(cur))}</td><td>{human_age(m.get('last_seen', 0))}</td>"
            f"<td>{html.escape(str(m.get('note') or ''))}</td></tr>"
        )
    tregs = []
    for tid, t in sorted(snap["tasks"].items()):
        st = t.get("status")
        cls = {"done": "done", "blocked": "bad", "failed": "bad", "stale": "warn"}.get(st, "todo")
        note = html.escape(str(t.get("note") or ""))
        prog = html.escape(str(t.get("progress") or ""))
        who = t.get("machine") or t.get("owner") or "-"
        tregs.append(
            f"<tr class='{cls}'><td>{html.escape(str(tid))}</td><td>{html.escape(str(st))}</td>"
            f"<td>{html.escape(str(who))}</td>"
            f"<td>{prog}</td><td>{note}</td><td>{human_age(t.get('updated_at', 0))}</td></tr>"
        )
    evs = []
    for e in reversed(snap["events"][-18:]):
        evs.append(
            f"<li><span class='t'>{time.strftime('%H:%M:%S', time.localtime(e['t']))}</span> "
            f"<b>{html.escape(str(e.get('machine') or ''))}</b> {html.escape(str(e.get('kind') or ''))} "
            f"{html.escape(str(e.get('task') or ''))} "
            f"{html.escape(str(e.get('text') or ''))}</li>"
        )
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>GP 作业板</title>
<style>
body{{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#0e1116;color:#e8ecf1;margin:0;padding:18px}}
h1{{font-size:18px;margin:0 0 4px}} .sub{{color:#8b949e;font-size:12px;margin-bottom:14px}}
table{{border-collapse:collapse;width:100%;margin-bottom:18px;font-size:13px}}
th,td{{border-bottom:1px solid #232a33;padding:6px 8px;text-align:left}}
th{{color:#8b949e;font-weight:400;font-size:12px}}
.on{{color:#5dd39e}} .off{{color:#e8756b}} .done td{{color:#5dd39e}}
.bad td{{color:#e8756b}} .warn td{{color:#e8b44b}} .todo td{{color:#c9d1d9}}
li{{font-size:13px;margin:3px 0;color:#c9d1d9}} .t{{color:#6e7681;font-family:Consolas,monospace}}
.pill{{display:inline-block;padding:2px 8px;border-radius:10px;background:#1b222b;margin-right:8px;font-size:12px}}
</style></head><body>
<h1>GP 作业板 · 四机现场</h1>
<div class="sub">{time.strftime('%Y-%m-%d %H:%M:%S')} · 每 5 秒刷新 · 共 {len(snap['tasks'])} 道工序</div>
<div><span class="pill">排队 {c.get('queued',0)}</span><span class="pill">进行中 {c.get('claimed',0)+c.get('running',0)}</span>
<span class="pill">完成 {c.get('done',0)}</span><span class="pill">卡住 {c.get('blocked',0)+c.get('failed',0)}</span>
<span class="pill">过期 {c.get('stale',0)}</span></div>
<h3>机器</h3><table><tr><th>角色</th><th>状态</th><th>正在做</th><th>最后心跳</th><th>备注</th></tr>
{''.join(rows)}</table>
<h3>工序</h3><table><tr><th>task_id</th><th>状态</th><th>谁</th><th>进度</th><th>备注</th><th>更新</th></tr>
{''.join(tregs)}</table>
<h3>最近动静</h3><ul>{''.join(evs)}</ul>
</body></html>"""


# ---------------------------------------------------------------- HTTP
# 可选鉴权：设了 GP_BOARD_TOKEN / GP_BOARD_TOKENS 就要求请求带 x-board-token。
# GP_BOARD_TOKENS 用逗号分隔，允许轮换期间新旧两枚同时有效；默认关闭（本地板子）。
# 读接口 /api/board 与 / （HTML 里也含 goal）同样要求 token；/api/health 保持公开，
# 因为客户端要先能探活、才知道该不该带 token。
BOARD_TOKENS = tuple(
    tok.strip()
    for chunk in (os.environ.get("GP_BOARD_TOKENS", ""), os.environ.get("GP_BOARD_TOKEN", ""))
    for tok in chunk.split(",")
    if tok.strip()
)
BOARD_TOKEN = BOARD_TOKENS[0] if BOARD_TOKENS else ""  # 兼容旧引用（health 的 auth 位）


def _token_ok(headers) -> bool:
    # v3.1：没有配置 token 一律不认（启动时已经 fail-closed 退出，这里只是兜底）。
    if not BOARD_TOKENS:
        return False
    got = (headers.get("x-board-token") or "").strip()
    if not got:
        return False
    # 按 bytes 比较：非 ASCII 头会让 hmac.compare_digest 抛 TypeError（未鉴权即可刷 traceback）。
    try:
        got_b = got.encode("utf-8")
    except Exception:
        return False
    for want in BOARD_TOKENS:
        try:
            if hmac.compare_digest(got_b, want.encode("utf-8")):
                return True
        except Exception:
            continue
    return False


def _origin_allowed(handler) -> bool:
    """防浏览器 CSRF：带 Origin 的跨站请求一律拒绝（含 /api/create 这类建单入口）。"""
    origin = (handler.headers.get("Origin") or "").strip()
    if not origin:
        return True  # 非浏览器客户端（curl / PowerShell / 插件）
    allow = {o.strip() for o in (os.environ.get("GP_BOARD_ORIGINS") or "").split(",") if o.strip()}
    return origin in allow


def _require_token(handler) -> bool:
    if _token_ok(handler.headers):
        return True
    handler._json(401, {"error": "unauthorized",
                        "hint": "这个板子开了鉴权，读写请求都必须带 x-board-token 头"})
    return False


class Handler(BaseHTTPRequestHandler):
    server_version = "GPBoard/1.0"

    def setup(self):
        super().setup()
        try:
            self.connection.settimeout(15)  # v1.3.11（M2）：半开连接最多占 15 秒
        except Exception:
            pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # v3.1：不再无条件 Access-Control-Allow-Origin: *。只有显式配了 GP_BOARD_ORIGINS
        # 才回单值 ACAO；跨站浏览器请求在 do_GET/do_POST 里已按 Origin 拒绝。
        allow = {o.strip() for o in (os.environ.get("GP_BOARD_ORIGINS") or "").split(",") if o.strip()}
        origin = (self.headers.get("Origin") or "").strip()
        if origin and origin in allow:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        if n > MAX_BODY_BYTES:  # v3.2（安全审计 M2）：超大 body 直接读空，不让线程被占满
            try:
                self.rfile.read(min(n, MAX_BODY_BYTES))
            except Exception:
                pass
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        try:
            print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)
        except Exception:
            pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/health":
            # v3.2（安全审计 L1）：公开面只回 ok，侦察信息（任务数/令牌枚数/版本/路由表）
            # 必须带 token 才给。守护脚本只判 ok 字段，不受影响。
            if not _token_ok(self.headers):
                self._json(200, {"ok": True})
                return
            self._json(200, {"ok": True, "uptime": int(time.time()), "tasks": len(STATE["tasks"]),
                             "auth": bool(BOARD_TOKENS), "authTokens": len(BOARD_TOKENS),
                             "authReads": True, "holder": True, "version": 4,
                             "hardened": True, "failClosed": True, "singleInstance": True,
                             "reconcileError": RECONCILE_ERROR,
                             "build": BUILD,
                             "routes": ["take", "untake", "attach", "mark", "release"]})
            return
        if not _origin_allowed(self):
            self._json(403, {"error": "origin not allowed", "hint": "跨站请求被拒；需要的话用 GP_BOARD_ORIGINS 显式放行"})
            return
        if not _require_token(self):
            return
        if u.path in ("/", "/index.html"):
            self._send(200, render_html(board_snapshot()).encode("utf-8"), "text/html; charset=utf-8")
        elif u.path == "/api/board":
            # v3.2（安全审计 C1）：出口再过一遍脱敏，防别的写入路径绕过入站过滤。
            self._json(200, redact_obj(board_snapshot()))
        else:
            self._json(404, {"error": "not found"})

    do_HEAD = do_GET

    def do_POST(self):
        u = urlparse(self.path)
        if not _origin_allowed(self):
            self._json(403, {"error": "origin not allowed", "hint": "跨站请求被拒；需要的话用 GP_BOARD_ORIGINS 显式放行"})
            return
        if not _require_token(self):
            return
        # v3.1：写接口必须是 JSON。浏览器 <form>/simple POST 的 text/plain 直接挡掉。
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype and ctype != "application/json":
            self._json(415, {"error": "unsupported media type", "hint": "写接口只接受 application/json"})
            return
        body = self._read_json()
        route = {
            "/api/claim": do_claim,
            "/api/beat": do_beat,
            "/api/release": do_release,
            "/api/say": do_say,
            "/api/seen": do_seen,
            "/api/seed": do_seed,
            "/api/create": do_create,
                "/api/caps": do_caps,
        "/api/metrics": do_metrics,
                "/api/mark": do_mark,
            "/api/attach": do_attach,
            "/api/take": do_take,
            "/api/untake": do_untake,
        }.get(u.path)
        if not route:
            self._json(404, {"error": "not found"})
            return
        try:
            body["__client"] = self.client_address[0]
        except Exception:
            pass
        try:
            code, obj = route(body)
        except Exception as e:  # noqa: BLE001
            code, obj = 500, {"error": f"{type(e).__name__}: {e}"}
        self._json(code, obj)


def lan_ips() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except Exception:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


def _pid_alive(pid: int) -> bool:
    """跨平台判断进程是否还活着。

    v3.2：Windows 上 os.kill(pid, 0) 会直接抛 OSError（并不像 POSIX 那样探测存活），
    之前据此误判成「僵尸锁」，导致第二个实例照样启动、两个进程同写一份 state.json。
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return False
            try:
                code = ctypes.c_ulong()
                ok = k32.GetExitCodeProcess(handle, ctypes.byref(code))
                return bool(ok) and code.value == STILL_ACTIVE
            finally:
                k32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


class BoardServer(ThreadingHTTPServer):
    """单实例 HTTP 服务：Windows 上显式 SO_EXCLUSIVEADDRUSE，避免两个进程绑同一端口。"""

    daemon_threads = True
    # socketserver 在 Windows 默认开 SO_REUSEADDR（等价于允许重复 bind）；关掉它，
    # 再补一个 SO_EXCLUSIVEADDRUSE，双保险。
    allow_reuse_address = False

    max_concurrent = 32

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        try:
            n = int(os.environ.get("GP_BOARD_MAX_CONN") or self.max_concurrent)
        except Exception:
            n = self.max_concurrent
        self._slots = threading.BoundedSemaphore(max(1, n))  # v1.3.11（M2）：线程数上限

    def process_request(self, request, client_address):
        if not self._slots.acquire(False):
            try:
                request.sendall(b"HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except Exception:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def server_bind(self):
        try:
            if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        except OSError:
            pass
        super().server_bind()


def main() -> int:
    global STATE_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8965)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--state", default="")
    args = ap.parse_args()

    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    STATE_PATH = args.state or os.path.join(base, "_board", "state.json")
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    # v3.1（安全复审 H1）：没有 token 一律不启动。过去的 fail-open 让任何人重启后
    # 都能得到一个绑 0.0.0.0、可被任意网页 CSRF 建 exec 单的裸板子。
    if not BOARD_TOKENS:
        print("[!] 拒绝启动：没有配置 GP_BOARD_TOKEN / GP_BOARD_TOKENS。", file=sys.stderr, flush=True)
        print("    请先设置 token（或从受保护的文件读入环境变量）再启动；裸板子会把读写接口全部敞开。",
              file=sys.stderr, flush=True)
        return 2

    # v3.1（安全复审 F1）：Windows 上 SO_REUSEADDR 允许两个进程同时 bind 同一端口，
    # 两边各持一份内存态互相覆盖。用 state 旁的锁文件做单实例保护。
    # 复核（v2.0.6，P2-14）：锁必须按状态文件的**规范化绝对路径** —— 一份状态只能有一个
    # 写入者。以前锁名带端口，同一份 state 换端口就能双开，各自维护内存快照、互相覆盖。
    # 同端口的第二实例继续由 socket 层（SO_EXCLUSIVEADDRUSE）拒绝。
    lock_path = "%s.lock" % os.path.realpath(STATE_PATH)
    lock_fh = None
    for _ in (0, 1):
        try:
            lock_fh = open(lock_path, "x")
            break
        except FileExistsError:
            pid = 0
            try:
                pid = int((open(lock_path, "r", encoding="utf-8").read() or "0").strip())
            except Exception:
                pid = 0
            alive = _pid_alive(pid)
            if alive:
                print(f"[!] 已有板子在跑（pid={pid}，锁文件 {lock_path}）。", file=sys.stderr, flush=True)
                print("    同一个 state.json 不能被两个进程同时写；先停掉那只再启动。", file=sys.stderr, flush=True)
                return 1
            try:
                os.remove(lock_path)
            except Exception:
                pass
    if lock_fh is None:
        print(f"[!] 拿不到单实例锁 {lock_path}，拒绝启动。", file=sys.stderr, flush=True)
        return 1
    try:
        lock_fh.write(str(os.getpid()))
        lock_fh.flush()
        lock_fh.close()
    except Exception:
        pass

    load_state()
    threading.Thread(target=reconcile_loop, daemon=True).start()
    try:
        httpd = BoardServer((args.bind, args.port), Handler)
    except OSError as e:
        print("[!] 绑定 %s:%d 失败：%s" % (args.bind, args.port, e), file=sys.stderr, flush=True)
        print("    端口已被占用（或无权绑定）。同一个端口只能有一个板子。", file=sys.stderr, flush=True)
        # v2.0.6 复审：bind 失败时把刚拿到的锁删掉，否则要靠 pid 复用/人工清理才能再启动。
        try:
            if lock_fh:
                lock_fh.close()
            os.remove(lock_path)
        except Exception:
            pass
        return 1
    httpd.daemon_threads = True
    print(f"作业板已启动，状态文件 {STATE_PATH}，鉴权 token {len(BOARD_TOKENS)} 枚", flush=True)
    for ip in lan_ips():
        print(f"  http://{ip}:{args.port}/", flush=True)
    print("  Ctrl+C 结束", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("已停止", flush=True)
    finally:
        try:
            os.remove(lock_path)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


