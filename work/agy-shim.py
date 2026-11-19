#!/usr/bin/python3
# bash falsa de bichi agy (se instala como /srv/hacksllm-agy/bin/bash). Lo que agy manda a la terminal se ejecuta en
# la PC del usuario: aqui solo se ve la salida. Solo usa la biblioteca estandar porque corre dentro del sandbox.
import json
import os
import shlex
import socket
import sys

SOCK = "/srv/hacksllm-agy/io/link.sock"
PC = os.environ.get("BICHI_PC", "/pc")


def command_of(args):
    # bash -c "..." / bash -lc "..." / bash -l -c "..."
    for index, arg in enumerate(args):
        if arg == "-c" or (arg.startswith("-") and not arg.startswith("--") and "c" in arg[1:]):
            return args[index + 1] if index + 1 < len(args) else ""
    # bash script.sh arg... : el script esta en el proyecto, asi que existe tambien en la PC
    files = [arg for arg in args if not arg.startswith("-")]
    if files:
        return "bash " + " ".join(shlex.quote(arg) for arg in files)
    return sys.stdin.read()


def main():
    command = command_of(sys.argv[1:])
    if not command.strip():
        return 0
    cwd = os.getcwd()
    rel = cwd[len(PC):].strip("/") if cwd == PC or cwd.startswith(PC + "/") else ""
    sock = socket.socket(socket.AF_UNIX)
    sock.connect(SOCK)
    link = sock.makefile("rwb")
    link.write((json.dumps({"op": "run", "command": command, "path": "/" + rel}) + "\n").encode())
    link.flush()
    reply = json.loads(link.readline() or b"{}")
    result = reply.get("ok") or {"out": "no se pudo ejecutar en la PC\n", "code": 126}
    sys.stdout.write(result["out"])
    sys.stdout.flush()
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
