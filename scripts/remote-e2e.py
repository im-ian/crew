#!/usr/bin/env python3
"""Remote bots end to end: one crew-router and several Crew daemons on this
machine, each with its own CREW_HOME, talking through the router.

    python3 scripts/remote-e2e.py --crew target/debug/crew \
        --router ../crew-router/target/release/crew-router

Every representative is a tiny shell bot that answers `ACK <last line>`, so
each reply carries the token it answers and a crossed reply shows. A's
representative may hand work to a local helper: a line with `DELEGATE` makes
it run `crew tell` to that helper and say `HANDED`.
"""

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

PORT = 17431
ALIAS = "lab"

BOT = """#!/bin/sh
for last; do :; done
line=$(printf '%s\\n' "$last" | grep -v '^[[:space:]]*$' | tail -n 1)
case "$line" in
  *DELEGATE*)
    "{crew}" tell {helper} "sub ${{line#*DELEGATE }}" >/dev/null 2>&1
    echo "HANDED $line" ;;
  *SLOW*) sleep 3; echo "ACK $line" ;;
  *FAIL*) exit 3 ;;
  *HANG*) sleep 60 ;;
  *ASK*)
    "{crew}" ask --question "Proceed?" --option yes --option no >/dev/null 2>&1
    echo "ASKED $line" ;;
  *) echo "ACK $line" ;;
esac
"""


class Node:
    def __init__(self, name, root, crew):
        self.name = name
        self.home = os.path.join(root, name)
        self.crew = crew
        os.makedirs(self.home)
        self.proc = None
        self.rep = None
        self.account = None

    def env(self):
        env = dict(os.environ)
        env.pop("CREW_AGENT_ID", None)
        env["CREW_HOME"] = self.home
        return env

    def start(self):
        log = open(os.path.join(self.home, "daemon.out"), "a")
        self.proc = subprocess.Popen(
            [self.crew, "daemon"], env=self.env(), stdout=log, stderr=log
        )
        wait(lambda: self.ping(), 10, f"{self.name} daemon up")

    def stop(self):
        if self.proc:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def ping(self):
        try:
            return self.rpc({"type": "ping"})["type"] == "pong"
        except OSError:
            return False

    def rpc(self, req, timeout=40):
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(timeout)
        s.connect(os.path.join(self.home, "crew.sock"))
        s.sendall((json.dumps(req) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            buf += chunk
        s.close()
        return json.loads(buf.decode().split("\n")[0])

    def cli(self, *args):
        out = subprocess.run(
            [self.crew, *args], env=self.env(), capture_output=True, text=True
        )
        return out.stdout + out.stderr

    def add_bot(self, name, root, helper="nobody", program=None):
        """`program` names the file, so Crew reads it as that CLI: a `grok`
        bot gets the first-output watch a custom command does not."""
        path = os.path.join(root, f"{self.name}-{name}.sh")
        if program:
            os.makedirs(os.path.join(root, f"{self.name}-bin"), exist_ok=True)
            path = os.path.join(root, f"{self.name}-bin", program)
        with open(path, "w") as f:
            f.write(BOT.format(crew=self.crew, helper=helper))
        os.chmod(path, 0o755)
        out = self.cli("agent", "add", "--headless", "--name", name, "--cmd", path)
        return out.split()[1]

    def messages(self, agent):
        ev = self.rpc({"type": "messages", "agent": agent})
        return ev.get("messages", [])

    def texts(self, agent, role="assistant"):
        return [m["text"] for m in self.messages(agent) if m["role"] == role]

    def remote(self):
        return self.rpc({"type": "remote_list"})["remotes"][0]

    def rid(self, other):
        if other.account:
            return f"{ALIAS}/{other.account}"
        for m in self.remote()["members"]:
            if m["name"] == other.name:
                return f"{ALIAS}/{m['account']}"
        raise KeyError(other.name)

    def jobs(self):
        try:
            with open(os.path.join(self.home, "remote-jobs.json")) as f:
                j = json.load(f)
            return len(j.get("out", [])) + len(j.get("in", []))
        except FileNotFoundError:
            return 0

    def pending_cards(self):
        return [
            m for m in self.messages(self.rep)
            if m.get("choice") and m["choice"]["state"] == "pending"
        ]

    def answer(self, card, option):
        return self.rpc({
            "type": "answer_choice", "agent": self.rep,
            "message_id": card["id"], "answers": [[option]],
        })


def wait(cond, secs, what):
    end = time.time() + secs
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:
            pass
        time.sleep(0.2)
    raise AssertionError(f"timed out: {what}")


def has(texts, token):
    return any(token in t for t in texts)


def together(*fns):
    threads = [threading.Thread(target=f) for f in fns]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


class World:
    def __init__(self, crew, router):
        self.root = tempfile.mkdtemp(prefix="crew-remote-e2e-")
        self.crew = crew
        self.router_bin = router
        self.router = None
        self.start_router()
        self.nodes = {}
        for name in "ABCDEFG":
            n = Node(name, self.root, crew)
            n.start()
            helper = None
            if name == "A":
                helper = n.add_bot("Helper", self.root)
                self.helper = helper
            # G's representative is read as grok, so a silent one is caught.
            program = "grok" if name == "G" else None
            n.rep = n.add_bot(f"Rep{name}", self.root, helper or "nobody", program)
            r = n.rpc({"type": "remote_join", "url": f"ws://127.0.0.1:{PORT}",
                       "alias": ALIAS, "name": name, "bot": n.rep})
            assert r["type"] == "ok", r
            self.nodes[name] = n
        a = self.nodes["A"]
        wait(lambda: len(a.remote()["members"]) == 6, 10, "everyone online")
        for n in self.nodes.values():
            n.account = n.rpc({"type": "remote_list"})["remotes"][0]["account"]
        # A..D trust each other. E and F are new to everyone.
        team = [self.nodes[k] for k in "ABCDG"]
        for n in team:
            n.rpc({"type": "remote_set", "alias": ALIAS,
                   "trusted": [m.account for m in team if m is not n]})
        a.rpc({"type": "remote_set", "alias": ALIAS, "delegates": [self.helper]})

    def __getitem__(self, k):
        return self.nodes[k]

    def start_router(self, *extra):
        rlog = open(os.path.join(self.root, "router.log"), "a")
        self.router = subprocess.Popen(
            [self.router_bin, "serve", "--listen", f"127.0.0.1:{PORT}",
             "--data", os.path.join(self.root, "router"), "--title", "E2E", *extra],
            stdout=rlog, stderr=rlog,
        )
        time.sleep(0.8)

    def stop_router(self):
        self.router.terminate()
        self.router.wait(5)

    def admin(self, *args):
        out = subprocess.run(
            [self.router_bin, *args, "--data", os.path.join(self.root, "router")],
            capture_output=True, text=True,
        )
        return out.stdout + out.stderr

    def connected(self, node):
        try:
            return node.remote()["connected"]
        except Exception:
            return False

    def close(self):
        for n in self.nodes.values():
            n.stop()
        self.stop_router()


def tell(src, dst, text, as_bot=False):
    """A fresh chain from the user, or `as_bot`: from `src`'s representative,
    which the answer then wakes. A bot's chain carries its hops along."""
    sender = src.rep if as_bot else "user"
    r = src.rpc({"type": "tell", "from": sender, "to": src.rid(dst), "text": text})
    assert r["type"] in ("told", "ok"), r


def got(src, dst, token, secs=20):
    """`src` holds `dst`'s answer to `token` in the remote chat."""
    wait(lambda: has(src.texts(src.rid(dst)), f"ACK {token}"), secs,
         f"{src.name} gets {dst.name}'s ACK {token}")


def settled(w, secs=20):
    wait(lambda: all(n.jobs() == 0 for n in w.nodes.values()), secs, "all jobs closed")


# ---- scenarios ----

def two_ask_a_at_once(w):
    a, c, d = w["A"], w["C"], w["D"]
    together(lambda: tell(c, a, "T1-C"), lambda: tell(d, a, "T1-D"))
    got(c, a, "T1-C")
    got(d, a, "T1-D")
    assert not has(c.texts(c.rid(a)), "T1-D"), "C saw D's answer"
    assert not has(d.texts(d.rid(a)), "T1-C"), "D saw C's answer"
    settled(w)


def one_sender_bursts(w):
    a, c = w["A"], w["C"]
    for i in range(3):
        tell(c, a, f"T2-{i}")
    for i in range(3):
        got(c, a, f"T2-{i}")
    order = [t for t in c.texts(c.rid(a)) if "T2-" in t]
    assert order == [f"ACK T2-{i}" for i in range(3)], order
    settled(w)


def crossing_tells(w):
    a, b = w["A"], w["B"]
    together(lambda: tell(a, b, "T3-A", as_bot=True), lambda: tell(b, a, "T3-B", as_bot=True))
    got(a, b, "T3-A")
    got(b, a, "T3-B")
    # Each woke on the other's answer. That wake is not the other's job.
    settled(w)
    for x, y, token in ((a, b, "T3-B"), (b, a, "T3-A")):
        replies = [t for t in y.texts(y.rid(x)) if token in t]
        assert replies == [f"ACK {token}"], (x.name, replies)


def four_ask_a_at_once(w):
    a = w["A"]
    senders = [w[k] for k in "BCD"]
    together(*[lambda s=s: tell(s, a, f"T4-{s.name}") for s in senders])
    for s in senders:
        got(s, a, f"T4-{s.name}")
    settled(w)


def mention_three_from_a(w):
    a, b, c, d = w["A"], w["B"], w["C"], w["D"]
    text = f"@{a.rid(b)} @{a.rid(c)} @{a.rid(d)} T5"
    assert a.rpc({"type": "send", "agent": w.helper, "text": text})["type"] == "ok"
    for s in (b, c, d):
        wait(lambda s=s: has(a.texts(a.rid(s)), "ACK"), 20, f"A hears {s.name}")
    handoffs = [m for m in a.messages(w.helper) if m.get("kind") == "handoff"]
    froms = {m["from"] for m in handoffs if "T5" in m["text"]}
    assert froms == {a.rid(b), a.rid(c), a.rid(d)}, froms
    settled(w)


def a_offline_two_send(w):
    a, c, d = w["A"], w["C"], w["D"]
    a.stop()
    tell(c, a, "T6-C")
    tell(d, a, "T6-D")
    time.sleep(1)
    a.start()
    got(c, a, "T6-C", 30)
    got(d, a, "T6-D", 30)
    settled(w, 30)


def cancel_while_offline(w):
    a, c = w["A"], w["C"]
    a.stop()
    tell(c, a, "T7-cancel")
    time.sleep(0.5)
    assert c.rpc({"type": "interrupt", "agent": c.rid(a)})["type"] == "ok"
    wait(lambda: any("취소" in t or "cancelled" in t
                     for t in c.texts(c.rid(a), role="system")), 15, "C sees cancelled")
    a.start()
    time.sleep(3)
    assert not has(a.texts(a.rep, role="system"), "T7-cancel"), "A ran a cancelled tell"
    settled(w, 30)


def newcomer_bursts_one_card(w):
    a, e = w["A"], w["E"]
    tell(e, a, "T8-1")
    tell(e, a, "T8-2")
    wait(lambda: len(a.pending_cards()) == 1, 15, "one card on A")
    time.sleep(1)
    assert len(a.pending_cards()) == 1, "a second card opened"
    a.answer(a.pending_cards()[0], "B")  # 이번만
    got(e, a, "T8-1")
    got(e, a, "T8-2")
    assert e.account not in [p["account"] for p in a.remote()["trusted"]]
    settled(w)


def two_newcomers_two_cards(w):
    a, e, f = w["A"], w["E"], w["F"]
    together(lambda: tell(e, a, "T9-E"), lambda: tell(f, a, "T9-F"))
    wait(lambda: len(a.pending_cards()) == 2, 15, "two cards on A")
    cards = a.pending_cards()
    for card in cards:
        q = card["choice"]["questions"][0]["question"]
        a.answer(card, "A" if q.startswith("E") else "C")  # E 허용, F 거절
    got(e, a, "T9-E")
    wait(lambda: any("받지 않았" in t or "did not take" in t
                     for t in f.texts(f.rid(a), role="system")), 15, "F refused")
    trusted = [p["account"] for p in a.remote()["trusted"]]
    assert e.account in trusted and f.account not in trusted, trusted
    settled(w)


def delegate_then_answer(w):
    a, c = w["A"], w["C"]
    tell(c, a, "DELEGATE T10")
    wait(lambda: has(c.texts(c.rid(a)), "HANDED"), 20, "C hears HANDED")
    wait(lambda: has(c.texts(c.rid(a)), "ACK sub T10"), 30, "C hears the helper's work")
    settled(w, 30)


def delegate_while_another_asks(w):
    a, c, d = w["A"], w["C"], w["D"]
    together(lambda: tell(c, a, "DELEGATE T11"), lambda: tell(d, a, "T11-D"))
    wait(lambda: has(c.texts(c.rid(a)), "ACK sub T11"), 30, "C hears the helper's work")
    got(d, a, "T11-D", 30)
    assert not has(d.texts(d.rid(a)), "sub T11"), "D got C's delegated answer"
    settled(w, 30)


def working(node):
    ag = [x for x in node.rpc({"type": "list"})["agents"] if x["id"] == node.rep][0]
    return ag["status"] == "working"


def system_says(node, other, *words):
    return any(any(w in t for w in words) for t in node.texts(node.rid(other), role="system"))


def owner_stops_a_remote_turn(w):
    a, c, d = w["A"], w["C"], w["D"]
    tell(c, a, "SLOW S1")
    tell(d, a, "S1-D")
    wait(lambda: working(a), 10, "A working on S1")
    assert a.rpc({"type": "interrupt", "agent": a.rep})["type"] == "ok"
    wait(lambda: system_says(c, a, "멈췄", "stopped"), 10, "C hears it was stopped")
    got(d, a, "S1-D")  # the next one in line still runs
    time.sleep(3.5)
    assert not has(c.texts(c.rid(a)), "ACK SLOW S1"), "C got an answer after the stop"
    settled(w)


def sender_cancels_a_running_turn(w):
    a, c = w["A"], w["C"]
    tell(c, a, "SLOW S2")
    wait(lambda: working(a), 10, "A working on S2")
    assert c.rpc({"type": "interrupt", "agent": c.rid(a)})["type"] == "ok"
    wait(lambda: system_says(c, a, "취소", "cancelled"), 10, "C sees cancelled")
    wait(lambda: not working(a), 10, "A stopped S2")
    time.sleep(3.5)
    assert not has(c.texts(c.rid(a)), "ACK SLOW S2"), "C got an answer after cancelling"
    settled(w)


def sender_cancels_a_queued_one(w):
    a, c, d = w["A"], w["C"], w["D"]
    tell(d, a, "SLOW S3-D")
    wait(lambda: working(a), 10, "A working on D's")
    tell(c, a, "S3-C")
    time.sleep(0.5)
    assert c.rpc({"type": "interrupt", "agent": c.rid(a)})["type"] == "ok"
    wait(lambda: system_says(c, a, "취소", "cancelled"), 10, "C sees cancelled")
    got(d, a, "SLOW S3-D", 15)  # D's turn was not the one cancelled
    time.sleep(1)
    assert not has(a.texts(a.rep), "ACK S3-C"), "A ran the cancelled one"
    settled(w)


def outbox_survives_a_restart(w):
    a, b = w["A"], w["B"]
    w.stop_router()
    wait(lambda: not w.connected(a), 10, "A sees the router gone")
    tell(a, b, "E1")
    a.stop()
    a.start()
    w.start_router()
    got(a, b, "E1", 45)
    settled(w, 45)


def big_attachments_refused(w):
    a, b = w["A"], w["B"]
    up = os.path.join(a.home, "uploads")
    os.makedirs(up, exist_ok=True)
    paths = []
    for i in range(2):
        path = os.path.join(up, f"big{i}.bin")
        with open(path, "wb") as f:
            f.write(os.urandom(16 * 1024 * 1024))
        paths.append(path)
    r = a.rpc({"type": "tell", "from": "user", "to": a.rid(b), "text": "E2 " + " ".join(paths)})
    assert r["type"] == "error" and "30MB" in r["message"], r
    assert w.connected(a), "A lost the router"
    tell(a, b, "E2-one " + paths[0])
    # B answers its last line, which names the file it got.
    wait(lambda: has(a.texts(a.rid(b)), "big0.bin"), 40, "B answers about the file")
    received = os.path.join(b.home, "uploads", "remote", ALIAS)
    assert any(f.endswith("big0.bin") for _, _, fs in os.walk(received) for f in fs), "B has no file"
    settled(w)


def cli_fails(w):
    a, c = w["A"], w["C"]
    tell(c, a, "FAIL E5")
    wait(lambda: system_says(c, a, "마치지 못했", "could not finish"), 15, "C hears it failed")
    settled(w)


def silent_cli(w):
    c, g = w["C"], w["G"]
    tell(c, g, "HANG E4")
    wait(lambda: system_says(c, g, "응답하지 않아", "did not respond"), 50, "C hears G is silent")
    tell(c, g, "E4-next")
    wait(lambda: any(m["text"] == "E4-next" and not m.get("queued") for m in g.messages(g.rep)),
         50, "G starts the next one")
    settled(w, 50)


def owner_talks_over(w):
    a, c = w["A"], w["C"]
    tell(c, a, "SLOW E6")
    wait(lambda: working(a), 10, "A working on E6")
    assert a.rpc({"type": "send", "agent": a.rep, "text": "owner line E6", "steer": True})["type"] == "ok"
    wait(lambda: system_says(c, a, "멈췄", "stopped"), 10, "C hears it was stopped")
    wait(lambda: has(a.texts(a.rep), "ACK owner line E6"), 15, "A answers its owner")
    settled(w)


def trust_card_after_restart(w):
    a, f = w["A"], w["F"]
    tell(f, a, "E8")
    wait(lambda: len(a.pending_cards()) == 1, 15, "a card on A")
    old = a.pending_cards()[0]["id"]
    a.stop()
    a.start()
    wait(lambda: [c["id"] for c in a.pending_cards()] not in ([], [old]), 30, "a fresh card")
    assert len(a.pending_cards()) == 1, "the old card is still open"
    a.answer(a.pending_cards()[0], "B")  # 이번만
    got(f, a, "E8", 20)
    settled(w)


def cancel_while_owner_is_asked(w):
    a, c = w["A"], w["C"]
    tell(c, a, "ASK E9")
    wait(lambda: len(a.pending_cards()) == 1, 15, "A's bot asks its owner")
    assert c.rpc({"type": "interrupt", "agent": c.rid(a)})["type"] == "ok"
    wait(lambda: system_says(c, a, "취소", "cancelled"), 10, "C sees cancelled")
    wait(lambda: not a.pending_cards(), 10, "the question closed")
    settled(w)


def router_restarts_while_a_is_off(w):
    a, c = w["A"], w["C"]
    a.stop()
    tell(c, a, "E10")
    time.sleep(1)
    w.stop_router()
    w.start_router()
    a.start()
    got(c, a, "E10", 45)
    settled(w, 45)


def renamed_member(w):
    b, c = w["B"], w["C"]
    w.admin("users", "rename", "B", "Bee")
    wait(lambda: any(m["name"] == "Bee" for m in c.remote()["members"]), 20, "C sees Bee")
    tell(c, b, "E12")
    got(c, b, "E12")
    settled(w)


def profile_follows(w):
    a, b, c = w["A"], w["B"], w["C"]
    seen = lambda n: next(m for m in n.remote()["members"] if m["name"] == "A")
    looks = lambda n: (seen(n).get("role"), seen(n).get("avatar_color"))
    c.stop()
    a.cli("agent", "set", a.rep, "--role", "새 역할", "--color", "#ff8800")
    wait(lambda: looks(b) == ("새 역할", "#ff8800"), 10, "B sees A's new look")
    c.start()
    wait(lambda: w.connected(c), 30, "C back online")
    wait(lambda: looks(c) == ("새 역할", "#ff8800"), 10, "C sees it after waking")
    settled(w)


def tell_expires(w):
    a, c = w["A"], w["C"]
    w.stop_router()
    w.start_router("--ttl-secs", "2")
    assert w.router.poll() is None, "this crew-router has no --ttl-secs"
    wait(lambda: w.connected(a) and w.connected(c), 45, "back online")
    a.stop()
    tell(c, a, "E7")
    wait(lambda: system_says(c, a, "지웠어요", "dropped"), 30, "C hears it expired")
    w.stop_router()
    w.start_router()
    a.start()
    time.sleep(3)
    assert not has(a.texts(a.rep, role="system"), "E7"), "A got an expired tell"
    settled(w, 45)


def same_account_twice(w):
    a = w["A"]
    twin = Node("A2", w.root, w.crew)
    shutil.copy(os.path.join(a.home, "remotes.json"), os.path.join(twin.home, "remotes.json"))
    twin.start()
    wait(lambda: a.remote().get("error"), 20, "A told it was replaced")
    assert "다른 곳" in a.remote()["error"] or "somewhere else" in a.remote()["error"]
    log = os.path.join(w.root, "router.log")
    before = open(log).read().count(f"online account={a.account}")
    time.sleep(6)
    after = open(log).read().count(f"online account={a.account}")
    assert after == before, f"the two kept taking turns ({after - before} sign-ins)"
    twin.stop()
    a.stop()
    a.start()
    wait(lambda: w.connected(a), 20, "A back")
    settled(w)


def kicked_member(w):
    f = w["F"]
    w.admin("users", "kick", "F")
    wait(lambda: f.remote().get("error"), 20, "F told it was removed")
    assert "지워졌" in f.remote()["error"] or "gone" in f.remote()["error"]


def representative_deleted_midway(w):
    c, d = w["C"], w["D"]
    tell(c, d, "SLOW E11")
    wait(lambda: working(d), 10, "D working")
    d.cli("agent", "remove", d.rep)
    wait(lambda: system_says(c, d, "사라졌", "left the router"), 20, "C hears D left")
    settled(w)


SCENARIOS = [
    ("C·D가 동시에 A에게", two_ask_a_at_once),
    ("C가 A에게 연달아 3개", one_sender_bursts),
    ("A↔B 서로 동시에", crossing_tells),
    ("B·C·D가 동시에 A에게", four_ask_a_at_once),
    ("A 사용자가 B·C·D 한 번에 멘션", mention_three_from_a),
    ("A가 꺼진 동안 C·D가 보냄", a_offline_two_send),
    ("A가 꺼진 동안 보내고 취소", cancel_while_offline),
    ("처음 보는 E가 연달아 2개 (카드 1장, 이번만)", newcomer_bursts_one_card),
    ("처음 보는 E·F가 동시에 (카드 2장, 허용/거절)", two_newcomers_two_cards),
    ("A 대표 봇이 로컬 봇에게 위임", delegate_then_answer),
    ("위임 중에 D가 끼어듦", delegate_while_another_asks),
    ("A 주인이 원격 일을 도중에 정지", owner_stops_a_remote_turn),
    ("C가 A가 처리 중인 일을 취소", sender_cancels_a_running_turn),
    ("C가 A에 대기 중인 일을 취소 (D 일은 계속)", sender_cancels_a_queued_one),
    ("라우터가 꺼진 동안 보내고 A 재시작", outbox_survives_a_restart),
    ("첨부 합 30MB 초과는 거절, 하나는 전달", big_attachments_refused),
    ("A 대표 봇 CLI가 오류로 끝남", cli_fails),
    ("G 대표 봇 CLI가 응답 없음", silent_cli),
    ("A 주인이 원격 일 도중 말을 검", owner_talks_over),
    ("승인 카드가 열린 채 A 재시작", trust_card_after_restart),
    ("A가 주인에게 물어보는 중 C가 취소", cancel_while_owner_is_asked),
    ("A가 꺼진 동안 라우터 재시작", router_restarts_while_a_is_off),
    ("관리자가 B 이름을 바꿈", renamed_member),
    ("A가 대표 봇 역할·색을 바꿈 (B 바로, 꺼져 있던 C는 켜질 때)", profile_follows),
    ("보관 기간이 지나 만료", tell_expires),
    ("같은 계정을 두 곳에서", same_account_twice),
    ("관리자가 F를 내보냄", kicked_member),
    ("D 대표 봇을 일 도중에 삭제", representative_deleted_midway),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--crew", required=True)
    ap.add_argument("--router", required=True)
    ap.add_argument("--only", help="run scenarios whose name contains this")
    ap.add_argument("--keep", action="store_true", help="keep the temp folder")
    args = ap.parse_args()
    w = World(os.path.abspath(args.crew), os.path.abspath(args.router))
    results = []
    try:
        for name, fn in SCENARIOS:
            if args.only and not any(o in name for o in args.only.split("|")):
                continue
            start = time.time()
            try:
                fn(w)
                results.append((name, "PASS", f"{time.time() - start:.1f}s"))
            except Exception as err:
                results.append((name, "FAIL", str(err)))
            print(f"{results[-1][1]}  {name}  {results[-1][2]}", flush=True)
    finally:
        w.close()
        if args.keep or any(r[1] == "FAIL" for r in results):
            print(f"logs: {w.root}")
        else:
            shutil.rmtree(w.root, ignore_errors=True)
    sys.exit(1 if any(r[1] == "FAIL" for r in results) else 0)


if __name__ == "__main__":
    main()
