import hashlib
import importlib.util
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


ENTRYPOINT = Path(__file__).with_name("hermes_project_planner_socket.py")
SECRET_CONTRACT = ENTRYPOINT.parents[2] / "domain/src/high-confidence-secret-contract.json"
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
            "stages": [],
        },
        "responsibilityCandidates": [{
            "kind": "human",
            "actorId": "10000000-0000-4000-8000-000000000004",
            "displayName": "Product Owner",
            "roles": ["project_owner"],
        }],
    }
    manifest = [{"artifactId": artifact_id, "version": 1, "sha256": digest}]
    return {
        "schemaVersion": 1,
        "operation": "project_plan.draft.generate",
        "idempotencyKey": "project-plan:1",
        "sourceManifest": manifest,
        "sourceManifestHash": hashlib.sha256(MODULE.canonical_json(manifest).encode()).hexdigest(),
        "planningContextHash": hashlib.sha256(MODULE.canonical_json(context).encode()).hexdigest(),
        "planningContext": context,
        "sources": [{"id": artifact_id, "sourceKind": "project_passport", "mediaType": "text/plain",
                     "sha256": digest, "content": content}],
        "authentication": {"scheme": "bearer", "token": token},
    }


class HermesProjectPlannerSocketTest(unittest.TestCase):
    def test_defensive_detector_matches_canonical_server_contract(self):
        contract = json.loads(SECRET_CONTRACT.read_text(encoding="utf-8"))
        for value in contract["reject"]:
            self.assertTrue(MODULE.contains_secret(value), value)
        for value in contract["allow"]:
            self.assertFalse(MODULE.contains_secret(value), value)

    def test_runtime_source_requires_dedicated_planner_config_and_scoped_credential(self):
        source = ENTRYPOINT.read_text(encoding="utf-8")
        self.assertIn('PLANNER_HOME = Path("/var/lib/fai-hermes-planner")', source)
        self.assertIn('FAI_HERMES_PLANNING_MODEL_CREDENTIAL_FILE', source)
        self.assertIn('contains_secret(config_path.read_text', source)
        self.assertNotIn('/var/lib/fai-hermes-controller', source)

    def test_model_credential_must_not_reuse_planning_bearer(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path = Path(directory) / "model-credential"
            credential_path.write_text("a" * 32 + "\n", encoding="utf-8")
            credential_path.chmod(0o600)
            environment = {"FAI_HERMES_PLANNING_MODEL_CREDENTIAL_FILE": str(credential_path)}
            with patch.object(MODULE, "MODEL_CREDENTIAL_PATH", credential_path), patch.dict(os.environ, environment):
                with self.assertRaisesRegex(RuntimeError, "model_credential_reuse"):
                    MODULE.load_model_credential({}, "a" * 32)
                credential_path.write_text("b" * 32 + "\n", encoding="utf-8")
                runtime = {}
                MODULE.load_model_credential(runtime, "a" * 32)
                self.assertEqual(runtime["api_key"], "b" * 32)

    def test_model_credential_accepts_bounded_oauth_tokens_only(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path = Path(directory) / "model-credential"
            environment = {"FAI_HERMES_PLANNING_MODEL_CREDENTIAL_FILE": str(credential_path)}
            with patch.object(MODULE, "MODEL_CREDENTIAL_PATH", credential_path), patch.dict(os.environ, environment):
                oauth_credential = "a" * 1686
                credential_path.write_text(oauth_credential + "\n", encoding="utf-8")
                credential_path.chmod(0o600)
                runtime = {}
                MODULE.load_model_credential(runtime, "b" * 32)
                self.assertEqual(runtime["api_key"], oauth_credential)
                credential_path.write_text("a" * 4097 + "\n", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "model_credential_value"):
                    MODULE.load_model_credential({}, "b" * 32)

    def test_kernel_peer_uid_when_supported(self):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            try:
                self.assertEqual(MODULE.peer_uid(left), os.getuid())
            except OSError:
                self.skipTest("SO_PEERCRED is Linux-specific")
        finally:
            left.close(); right.close()
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            with patch.object(MODULE, "peer_uid", return_value=os.getuid()), \
                 self.assertRaisesRegex(RuntimeError, "peer_uid"):
                MODULE.handle_connection(left, os.getuid() + 1, "a" * 32, {}, {})
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
        secret["sourceManifestHash"] = hashlib.sha256(
            MODULE.canonical_json(secret["sourceManifest"]).encode()).hexdigest()
        with self.assertRaisesRegex(RuntimeError, "source_content"):
            MODULE.parse_request(MODULE.canonical_json(secret).encode(), "a" * 32)

    def test_authenticated_health_is_side_effect_free_and_commit_bound(self):
        request = {"schemaVersion": 1, "operation": "health",
                   "nonce": "10000000-0000-4000-8000-000000000009",
                   "authentication": {"scheme": "bearer", "token": "a" * 32}}
        parsed = MODULE.parse_request(MODULE.canonical_json(request).encode(), "a" * 32)
        self.assertEqual(parsed, {"schemaVersion": 1, "operation": "health", "nonce": request["nonce"]})

    def test_idempotency_registry_is_count_and_ttl_bounded(self):
        registry = MODULE.IdempotencyRegistry(maximum=2, ttl_seconds=5)
        calls = []
        with patch.object(MODULE.time, "monotonic", side_effect=[0, 0, 1, 1, 2, 2, 8, 8]):
            for key in ("one", "two", "three", "two"):
                registry.execute(key, hashlib.sha256(key.encode()).hexdigest(),
                                 lambda key=key: calls.append(key) or key.encode())
        self.assertLessEqual(len(registry.entries), 2)
        self.assertEqual(calls, ["one", "two", "three", "two"])

    def test_identical_in_flight_wait_is_bounded(self):
        registry = MODULE.IdempotencyRegistry(maximum=2, ttl_seconds=5, coalesced_wait_seconds=0.05)
        started = threading.Event()
        release = threading.Event()
        owner_error = []

        def blocked_response():
            started.set()
            self.assertTrue(release.wait(2))
            return b"response"

        def own_request():
            try:
                registry.execute("one", "a" * 64, blocked_response)
            except Exception as exception:
                owner_error.append(exception)

        owner = threading.Thread(target=own_request)
        owner.start()
        self.assertTrue(started.wait(1))
        wait_started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "idempotency_wait_timeout"):
            registry.execute("one", "a" * 64, lambda: b"unexpected")
        self.assertLess(time.monotonic() - wait_started, 0.5)
        release.set()
        owner.join(1)
        self.assertFalse(owner.is_alive())
        self.assertFalse(owner_error)

    def test_failed_admission_does_not_poison_idempotent_retry(self):
        registry = MODULE.IdempotencyRegistry(maximum=2, ttl_seconds=5)
        with self.assertRaisesRegex(RuntimeError, "provider_busy"):
            registry.execute("retry", "a" * 64, lambda: MODULE.fail("provider_busy"))
        self.assertEqual(registry.execute("retry", "a" * 64, lambda: b"response"), b"response")

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

    def test_concurrent_idempotency_coalesces_replays_denies_collision_and_keeps_health_responsive(self):
        registry = MODULE.IdempotencyRegistry(maximum=4, ttl_seconds=60)
        provider_slot = threading.Semaphore(1)
        generate_slots = threading.BoundedSemaphore(16)
        started = threading.Event(); release = threading.Event()
        definition = {"title": "Plan", "outcomes": [], "milestones": [], "risks": [], "tasks": []}
        provider_calls = 0

        def blocked_planner(*_args, **_kwargs):
            nonlocal provider_calls
            provider_calls += 1
            started.set()
            self.assertTrue(release.wait(2))
            return MODULE.canonical_json(definition)

        def exchange(request):
            server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            body = MODULE.canonical_json(request).encode()
            client.sendall(struct.pack("!I", len(body)) + body)
            error = []
            def handle():
                try:
                    with patch.object(MODULE, "peer_uid", return_value=os.getuid()):
                        MODULE.handle_connection(server, os.getuid(), "a" * 32, {"configSha256": "c" * 64}, {},
                                                 registry, provider_slot, generate_slots)
                except Exception as exception:
                    error.append(exception)
                finally:
                    server.close()
            thread = threading.Thread(target=handle); thread.start()
            return client, thread, error

        with patch.object(MODULE, "run_planner", side_effect=blocked_planner):
            first_client, first_thread, first_error = exchange(fixture())
            self.assertTrue(started.wait(1))
            second_client, second_thread, second_error = exchange(fixture())
            busy_started = time.monotonic()
            busy_exchanges = []
            for index in range(8):
                distinct = fixture()
                distinct["idempotencyKey"] = f"project-plan:busy-{index}"
                busy_exchanges.append(exchange(distinct))
            for client, thread, errors in busy_exchanges:
                thread.join(1)
                self.assertFalse(thread.is_alive())
                client.close()
                self.assertEqual(len(errors), 1)
                self.assertRegex(str(errors[0]), "provider_busy")
            self.assertLess(time.monotonic() - busy_started, 1)
            self.assertEqual(provider_calls, 1)
            health = {"schemaVersion": 1, "operation": "health",
                      "nonce": "10000000-0000-4000-8000-000000000009",
                      "authentication": {"scheme": "bearer", "token": "a" * 32}}
            with patch.dict(os.environ, {"FAI_HERMES_PLANNING_RELEASE_COMMIT": "d" * 40}):
                health_started = time.monotonic()
                health_client, health_thread, health_error = exchange(health)
                health_size = struct.unpack("!I", MODULE.read_exact(health_client, 4))[0]
                health_response = json.loads(MODULE.read_exact(health_client, health_size))
                self.assertLess(time.monotonic() - health_started, 2)
                self.assertEqual(health_response["status"], "ready")
                health_thread.join(1); health_client.close()
                self.assertFalse(health_error)
            release.set()
            responses = []
            for client, thread, errors in ((first_client, first_thread, first_error),
                                           (second_client, second_thread, second_error)):
                size = struct.unpack("!I", MODULE.read_exact(client, 4))[0]
                responses.append(MODULE.read_exact(client, size))
                thread.join(1); client.close(); self.assertFalse(errors)
            self.assertEqual(responses[0], responses[1])
            self.assertEqual(provider_calls, 1)
            replay_client, replay_thread, replay_error = exchange(fixture())
            replay_size = struct.unpack("!I", MODULE.read_exact(replay_client, 4))[0]
            self.assertEqual(MODULE.read_exact(replay_client, replay_size), responses[0])
            replay_thread.join(1); replay_client.close(); self.assertFalse(replay_error)
            self.assertEqual(provider_calls, 1)

            collision = fixture(); collision["sources"][0]["content"] = "Different confirmed passport"
            collision["sources"][0]["sha256"] = hashlib.sha256(collision["sources"][0]["content"].encode()).hexdigest()
            collision["sourceManifest"][0]["sha256"] = collision["sources"][0]["sha256"]
            collision["sourceManifestHash"] = hashlib.sha256(
                MODULE.canonical_json(collision["sourceManifest"]).encode()).hexdigest()
            collision_client, collision_thread, collision_error = exchange(collision)
            collision_thread.join(1); collision_client.close()
            self.assertRegex(str(collision_error[0]), "idempotency_collision")
            self.assertEqual(provider_calls, 1)


if __name__ == "__main__":
    unittest.main()
