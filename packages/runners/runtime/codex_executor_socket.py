#!/usr/bin/env python3
"""Length-framed, peer-UID-authenticated Hermes controller to Codex executor bridge."""
import hashlib
import json
import os
import socket
import struct
import subprocess
from pathlib import Path

MAX_FRAME = 256 * 1024
SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)
FORBIDDEN_KEYS = {"path", "command", "args", "credential", "credentials", "secret", "token", "env", "argv"}
FORBIDDEN_TEXT = ("\x00", "`", "$(", "&&", "||", "/etc/", "/root/", "/var/lib/fai-hermes")


def fail(code: str):
    raise RuntimeError(code)


def bounded_message(value, depth=0):
    if depth > 16:
        return False
    if isinstance(value, dict):
        return len(value) <= 128 and all(isinstance(key, str) and key.lower() not in FORBIDDEN_KEYS and
                                         bounded_message(item, depth + 1) for key, item in value.items())
    if isinstance(value, list):
        return len(value) <= 256 and all(bounded_message(item, depth + 1) for item in value)
    if isinstance(value, str):
        return len(value) <= 16_384 and not any(marker in value for marker in FORBIDDEN_TEXT)
    return value is None or isinstance(value, (bool, int, float))


def read_frame(connection):
    header = connection.recv(4)
    if len(header) != 4:
        fail("frame_header")
    size = struct.unpack("!I", header)[0]
    if size < 1 or size > MAX_FRAME:
        fail("frame_size")
    body = bytearray()
    while len(body) < size:
        chunk = connection.recv(size - len(body))
        if not chunk:
            fail("frame_truncated")
        body.extend(chunk)
    return bytes(body)


def serve_once(listener, expected_uid, node, bundle, clean_env):
    connection, _ = listener.accept()
    with connection:
        pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, 12))
        if pid < 1 or uid != expected_uid:
            fail("peer_uid")
        body = read_frame(connection)
        request = json.loads(body)
        if not isinstance(request, dict) or request.get("schemaVersion") != 1 or not bounded_message(request):
            fail("message_schema")
        result = subprocess.run([node, bundle], input=body, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env=clean_env, timeout=180, check=False)
        if result.returncode != 0 or len(result.stdout) < 1 or len(result.stdout) > MAX_FRAME:
            fail("executor_failed")
        connection.sendall(struct.pack("!I", len(result.stdout)) + result.stdout)


def main():
    socket_path = Path(os.environ["FAI_EXECUTOR_SOCKET"])
    node = Path(os.environ["FAI_EXECUTOR_NODE"])
    bundle = Path(os.environ["FAI_EXECUTOR_BUNDLE"])
    expected_hash = os.environ["FAI_EXECUTOR_BUNDLE_SHA256"]
    expected_uid = int(os.environ["FAI_CONTROLLER_UID"])
    if not socket_path.is_absolute() or not node.is_absolute() or not bundle.is_absolute() or \
       hashlib.sha256(bundle.read_bytes()).hexdigest() != expected_hash:
        fail("bundle_binding")
    clean_env = {key: os.environ[key] for key in ("FAI_EXECUTOR_CODEX_HOME", "FAI_EXECUTOR_REPOSITORY_ROOT",
                 "FAI_EXECUTOR_WORKTREE_ROOT", "FAI_EXECUTOR_ARTIFACT_ROOT",
                 "FAI_EXECUTOR_EXPECTED_HERMES_CONFIG_SHA256", "FAI_EXECUTOR_CODEX_VERSION",
                 "FAI_EXECUTOR_REPOSITORY")}
    clean_env.update({"HOME": clean_env["FAI_EXECUTOR_CODEX_HOME"], "PATH": "/usr/bin:/bin", "NO_COLOR": "1"})
    if socket_path.exists():
        socket_path.unlink()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(socket_path)); os.chmod(socket_path, 0o660); listener.listen(8)
        while True:
            try:
                serve_once(listener, expected_uid, str(node), str(bundle), clean_env)
            except Exception:
                continue


if __name__ == "__main__":
    main()
