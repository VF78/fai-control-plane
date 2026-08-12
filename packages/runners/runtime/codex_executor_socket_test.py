import importlib.util
import socket
import struct
import unittest
from pathlib import Path


ENTRYPOINT = Path(__file__).with_name("codex_executor_socket.py")
SPEC = importlib.util.spec_from_file_location("codex_executor_socket", ENTRYPOINT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CodexExecutorSocketTest(unittest.TestCase):
    def test_peer_uid_mismatch_fails_before_reading_frame(self):
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def getsockopt(self, *_args): return struct.pack("3i", 42, 2002, 2002)
            def recv(self, _size): raise AssertionError("frame read before peer validation")
        class Listener:
            def accept(self): return Connection(), None
        with self.assertRaisesRegex(RuntimeError, "peer_uid"):
            MODULE.serve_once(Listener(), 1001, "/usr/bin/node", "/fixed/bundle", {})

    def test_bounded_message_rejects_control_paths_commands_and_credentials(self):
        self.assertTrue(MODULE.bounded_message({"schemaVersion": 1, "runId": "bounded-id"}))
        for value in ({"command": "git status"}, {"args": []}, {"token": "opaque"},
                      {"goal": "/etc/passwd"}, {"goal": "$(id)"}):
            self.assertFalse(MODULE.bounded_message(value))

    def test_length_frame_is_exact_and_capped(self):
        left, right = socket.socketpair()
        try:
            body = b'{"schemaVersion":1}'
            left.sendall(struct.pack("!I", len(body)) + body)
            self.assertEqual(MODULE.read_frame(right), body)
            left.sendall(struct.pack("!I", MODULE.MAX_FRAME + 1))
            with self.assertRaisesRegex(RuntimeError, "frame_size"):
                MODULE.read_frame(right)
        finally:
            left.close(); right.close()


if __name__ == "__main__":
    unittest.main()
