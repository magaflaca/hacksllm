#!/usr/bin/env python3
# Disco de bichi agy: una carpeta FUSE cuyo contenido vive en la PC del usuario. Cada operacion se le pregunta al
# servicio por su enchufe unix (agy.mjs), que guarda en cache lo que ya sabe y pregunta a bichi code el resto.
#   agy-fs.py <carpeta> <enchufe> <uid> <gid>
import base64
import errno
import json
import socket
import stat
import sys
import threading

import mfusepy as fuse

MNT, SOCK, UID, GID = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
local = threading.local()


def ask(**message):
    if not hasattr(local, "link"):
        sock = socket.socket(socket.AF_UNIX)
        sock.connect(SOCK)
        local.link = sock.makefile("rwb")
    local.link.write((json.dumps(message) + "\n").encode())
    local.link.flush()
    line = local.link.readline()
    if not line:
        raise fuse.FuseOSError(errno.EIO)
    reply = json.loads(line)
    if reply.get("errno"):
        raise fuse.FuseOSError(reply["errno"])
    return reply.get("ok")


class Disk(fuse.Operations):
    use_ns = False

    def getattr(self, path, fh=None):
        node = ask(op="getattr", path=path)
        mode = (stat.S_IFDIR | 0o755) if node["dir"] else (stat.S_IFREG | 0o644)
        return {
            "st_mode": mode,
            "st_size": node["size"],
            "st_mtime": node["mtime"],
            "st_atime": node["mtime"],
            "st_ctime": node["mtime"],
            "st_nlink": 2 if node["dir"] else 1,
            "st_uid": UID,
            "st_gid": GID,
        }

    def readdir(self, path, fh):
        return [".", ".."] + ask(op="readdir", path=path)

    def read(self, path, size, offset, fh):
        return base64.b64decode(ask(op="read", path=path, size=size, offset=offset))

    def write(self, path, data, offset, fh):
        return ask(op="write", path=path, data=base64.b64encode(data).decode(), offset=offset)

    def truncate(self, path, length, fh=None):
        ask(op="truncate", path=path, length=length)
        return 0

    def create(self, path, mode, fi=None):
        ask(op="create", path=path)
        return 0

    def open(self, path, flags):
        # O_TRUNC llega aparte como truncate (el kernel lo separa), asi que abrir no hace nada.
        return 0

    def flush(self, path, fh):
        ask(op="flush", path=path)
        return 0

    release = flush

    def fsync(self, path, datasync, fh):
        return self.flush(path, fh)

    def unlink(self, path):
        ask(op="unlink", path=path)
        return 0

    def rmdir(self, path):
        ask(op="rmdir", path=path)
        return 0

    def mkdir(self, path, mode):
        ask(op="mkdir", path=path)
        return 0

    def rename(self, old, new):
        ask(op="rename", path=old, to=new)
        return 0

    def chmod(self, path, mode):
        return 0

    def chown(self, path, uid, gid):
        return 0

    def utimens(self, path, times=None):
        return 0

    def statfs(self, path):
        return {"f_bsize": 4096, "f_frsize": 4096, "f_blocks": 1 << 22, "f_bfree": 1 << 21, "f_bavail": 1 << 21, "f_files": 1 << 20, "f_ffree": 1 << 19, "f_namemax": 255}


if __name__ == "__main__":
    fuse.FUSE(Disk(), MNT, foreground=True, nothreads=False, allow_other=True)
