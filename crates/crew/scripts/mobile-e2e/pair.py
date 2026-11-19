import json, os, socket, sys
s = socket.socket(socket.AF_UNIX); s.connect(os.path.join(sys.argv[1], "crew.sock"))
s.sendall(b'{"type":"mobile","action":"pair"}\n')
buf = b""
while True:
    buf += s.recv(65536)
    for line in buf.split(b"\n")[:-1]:
        ev = json.loads(line)
        if ev.get("type") in ("mobile", "error"):
            info = ev.get("info", ev); print(json.dumps({k: info.get(k) for k in ("code", "url", "message")}, ensure_ascii=False)); sys.exit()
