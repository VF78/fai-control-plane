import hashlib
import importlib.util
import json
import os
import socket
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ENTRYPOINT = Path(__file__).with_name("hermes_project_planner_socket.py")
sys.path.insert(0, str(ENTRYPOINT.parent))
SPEC = importlib.util.spec_from_file_location("hermes_project_planner_socket", ENTRYPOINT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture(token="a" * 32):
    artifact_id = "10000000-0000-4000-8000-000000000001"
    content = "Confirmed project passport"
    digest = hashlib.sha256(content.encode()).hexdigest()
    context = {
        "schemaVersion": 1,
        "projectId": "10000000-0000-4000-8000-000000000002",
        "deliveryProtocol": {
            "id": "10000000-0000-4000-8000-000000000003",
            "revision": 1,
            "contentHash": "b" * 64,
            "definition": {"schemaVersion": 1, "stages": []},
        },
        "responsibilityCandidates": [{
            "kind": "human",
            "actorId": "10000000-0000-4000-8000-000000000004",
            "displayName": "Product Owner",
            "roles": ["project_owner"],
        }],
    }
    return {
        "schemaVersion": 1,
        "operation": "project_plan.draft.generate",
        "idempotencyKey": "project-plan:1",
        "sourceManifest": [{"artifactId": artifact_id, "version": 1, "sha256": digest}],
        "planningContextHash": hashlib.sha256(MODULE.canonical_json(context).encode()).hexdigest(),
        "planningContext": context,
        "sources": [{"id": artifact_id, "sourceKind": "project_passport", "mediaType": "text/plain",
                     "sha256": digest, "content": content}],
        "authentication": {"scheme": "bearer", "token": token},
    }


class HermesProjectPlannerSocketTest(unittest.TestCase):
    def test_kernel_peer_uid_when_supported(self):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            try:
                self.assertEqual(MODULE.peer_uid(left), os.getuid())
            except OSError:
                self.skipTest("SO_PEERCRED is Linux-specific")
        finally:
            left.close(); right.close()

    def test_authenticated_request_strips_token_and_calls_zero_tools_planner_contract(self):
        request = MODULE.parse_request(MODULE.canonical_json(fixture()).encode(), "a" * 32)
        self.assertNotIn("authentication", request)
        definition = {"title": "Plan", "outcomes": [], "milestones": [], "risks": [], "tasks": []}
        with patch.object(MODULE, "run_planner", return_value=MODULE.canonical_json(definition)) as planner:
            response = json.loads(MODULE.generate({"model": "bounded"}, {"provider": "test"}, request))
        self.assertEqual(response, {"definition": definition})
        call = planner.call_args
        self.assertEqual(call.kwargs["system_prompt"], MODULE.SYSTEM_PROMPT)
        self.assertEqual(call.kwargs["max_tokens"], 16_384)
        self.assertNotIn("authentication", call.args[2])
        source = ENTRYPOINT.read_text(encoding="utf-8")
        self.assertNotIn("AIAgent", source)
        self.assertNotIn("from run_agent import", source)

    def test_rejects_wrong_token_context_drift_and_secret_source(self):
        with self.assertRaisesRegex(RuntimeError, "authentication"):
            MODULE.parse_request(MODULE.canonical_json(fixture("b" * 32)).encode(), "a" * 32)
        drifted = fixture(); drifted["planningContextHash"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "context_hash"):
            MODULE.parse_request(MODULE.canonical_json(drifted).encode(), "a" * 32)
        secret = fixture(); secret["sources"][0]["content"] = "api_key=sk-" + "x" * 24
        secret["sources"][0]["sha256"] = hashlib.sha256(secret["sources"][0]["content"].encode()).hexdigest()
        secret["sourceManifest"][0]["sha256"] = secret["sources"][0]["sha256"]
        with self.assertRaisesRegex(RuntimeError, "source_content"):
            MODULE.parse_request(MODULE.canonical_json(secret).encode(), "a" * 32)

    def test_length_framing_and_peer_uid_are_enforced(self):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            body = MODULE.canonical_json(fixture()).encode()
            right.sendall(struct.pack("!I", len(body)) + body)
            with patch.object(MODULE, "peer_uid", return_value=os.getuid()), \
                 patch.object(MODULE, "generate", return_value=b'{"definition":{}}'):
                MODULE.handle_connection(left, os.getuid(), "a" * 32, {}, {})
            size = struct.unpack("!I", MODULE.read_exact(right, 4))[0]
            self.assertEqual(MODULE.read_exact(right, size), b'{"definition":{}}')
        finally:
            left.close(); right.close()
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            with patch.object(MODULE, "peer_uid", return_value=os.getuid()), \
                 self.assertRaisesRegex(RuntimeError, "peer_uid"):
                MODULE.handle_connection(left, os.getuid() + 1, "a" * 32, {}, {})
        finally:
            left.close(); right.close()


if __name__ == "__main__":
    unittest.main()
