#!/usr/bin/env python3
"""Bounded authenticated health client for the Hermes planner UDS."""

import argparse
import json
import os
import re
import socket
import stat
import struct
import uuid
from pathlib import Path


def read_exact(connection: socket.socket, size: int) -> bytes:
    chunks = []
    received = 0
    while received < size:
        chunk = connection.recv(size - received)
        if not chunk:
            raise RuntimeError("truncated")
        chunks.append(chunk)
        received += len(chunk)
    return b"".join(chunks)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--release-commit", required=True)
    args = parser.parse_args()
    socket_path = Path(args.socket)
    token_path = Path(args.token_file)
    if socket_path != Path("/run/fai-hermes-planner/planner.sock") or socket_path.is_symlink() or \
       not stat.S_ISSOCK(socket_path.lstat().st_mode) or token_path.is_symlink() or \
       not stat.S_ISREG(token_path.lstat().st_mode) or not re.fullmatch(r"[0-9a-f]{40}", args.release_commit):
        return 1
    token = token_path.read_text(encoding="utf-8").removesuffix("\n")
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{32,256}", token):
        return 1
    nonce = str(uuid.uuid4())
    body = json.dumps({"schemaVersion": 1, "operation": "health", "nonce": nonce,
                       "authentication": {"scheme": "bearer", "token": token}},
                      separators=(",", ":"), sort_keys=True).encode()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3.0)
        connection.connect(str(socket_path))
        connection.sendall(struct.pack("!I", len(body)) + body)
        size = struct.unpack("!I", read_exact(connection, 4))[0]
        if size < 1 or size > 4096:
            return 1
        response = read_exact(connection, size)
    value = json.loads(response)
    expected = {"status", "operation", "nonce", "releaseCommit", "configSha256"}
    return 0 if set(value) == expected and value["status"] == "ready" and value["operation"] == "health" and \
        value["nonce"] == nonce and value["releaseCommit"] == args.release_commit and \
        isinstance(value["configSha256"], str) and re.fullmatch(r"[0-9a-f]{64}", value["configSha256"]) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(1)
