import importlib.util
import json
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).parents[1] / "extensions/fai-control-plane"
SPEC = importlib.util.spec_from_file_location("fai_control_plane", ROOT / "__init__.py",
                                              submodule_search_locations=[str(ROOT)])
PLUGIN = importlib.util.module_from_spec(SPEC)
sys.modules["fai_control_plane"] = PLUGIN
SPEC.loader.exec_module(PLUGIN)


class Context:
    def __init__(self):
        self.tools = []
        self.hooks = {}
        self.state = State()

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_hook(self, name, handler):
        self.hooks[name] = handler


class State:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


class PluginTest(unittest.TestCase):
    def setUp(self):
        PLUGIN.bridge_state.reset_for_test()

    def test_registers_bounded_tools_and_identity_hooks(self):
        context = Context()
        PLUGIN.register(context)
        self.assertEqual(len(context.tools), 13)
        self.assertEqual({tool["toolset"] for tool in context.tools}, {"fai_internal", "fai_client"})
        self.assertIn("pre_gateway_dispatch", context.hooks)
        self.assertIn("pre_llm_call", context.hooks)

    def test_context_hook_injects_current_capsule_and_reuses_conditional_version(self):
        context = Context()
        PLUGIN.register(context)
        PLUGIN.bridge_state.stage(platform="telegram", user_id="96211907", chat_id="-5540760630",
                                  update_id="77", message_id="12")
        self.assertTrue(PLUGIN.bridge_state.promote(platform="telegram", user_id="96211907",
                                                    chat_id="-5540760630", session_id="s1"))
        captured = []
        original = PLUGIN._post
        version = "a" * 64
        responses = [json.dumps({"status": "completed", "version": version, "capsule": "Current rules",
                                 "sourceCount": 4, "refreshedAt": "2026-08-24T10:00:00Z"}),
                     json.dumps({"status": "duplicate", "version": version, "sourceCount": 4,
                                 "refreshedAt": "2026-08-24T10:00:00Z"})]
        PLUGIN._post = lambda profile, source, action, response_limit=4096: (
            captured.append((profile, source, action, response_limit)) or responses.pop(0))
        try:
            first = context.hooks["pre_llm_call"](session_id="s1", platform="telegram")
            second = context.hooks["pre_llm_call"](session_id="s1", platform="telegram")
        finally:
            PLUGIN._post = original
        self.assertIn("Current rules", first["context"])
        self.assertIn("Current rules", second["context"])
        self.assertIsNone(captured[0][2]["ifVersion"])
        self.assertEqual(captured[1][2]["ifVersion"], version)
        self.assertEqual(captured[0][3], 8192)

    def test_context_hook_fails_closed_then_marks_cached_context_stale(self):
        context = Context()
        PLUGIN.register(context)
        PLUGIN.bridge_state.stage(platform="telegram", user_id="96211907", chat_id="-5540760630",
                                  update_id="77", message_id="12")
        self.assertTrue(PLUGIN.bridge_state.promote(platform="telegram", user_id="96211907",
                                                    chat_id="-5540760630", session_id="s1"))
        original = PLUGIN._post
        PLUGIN._post = lambda *_args, **_kwargs: json.dumps({"error": "control_plane_unavailable"})
        try:
            empty = context.hooks["pre_llm_call"](session_id="s1", platform="telegram")
            context.state.set("project_context_version", "b" * 64)
            context.state.set("project_context_capsule", "Cached rules")
            stale = context.hooks["pre_llm_call"](session_id="s1", platform="telegram")
        finally:
            PLUGIN._post = original
        self.assertIn("unavailable", empty["context"])
        self.assertIn("may be stale", stale["context"])
        self.assertIn("Cached rules", stale["context"])

    def test_tool_injects_promoted_identity_not_model_arguments(self):
        source = types.SimpleNamespace(platform=types.SimpleNamespace(value="telegram"),
                                       user_id="96211907", chat_id="-5540760630")
        event = types.SimpleNamespace(source=source, platform_update_id=77, message_id=12)
        self.assertEqual(PLUGIN._pre_dispatch(event), {"action": "allow"})
        self.assertTrue(PLUGIN.bridge_state.promote(platform="telegram", user_id="96211907",
                                                    chat_id="-5540760630", session_id="s1"))
        captured = {}
        original = PLUGIN._post
        PLUGIN._post = lambda profile, native_source, action: captured.update(
            profile=profile, source=native_source, action=action) or '{"status":"completed"}'
        try:
            result = PLUGIN._handler("issue.create")({"title": "Bug", "statement": "Observed"}, session_id="s1")
        finally:
            PLUGIN._post = original
        self.assertEqual(result, '{"status":"completed"}')
        self.assertEqual(captured["source"]["userId"], "96211907")
        self.assertEqual(captured["source"]["updateId"], "77")
        self.assertNotIn("userId", captured["action"])

    def test_process_start_is_one_bounded_internal_tool(self):
        context = Context()
        PLUGIN.register(context)
        tool = next(tool for tool in context.tools if tool["name"] == "fai_process_start")
        self.assertEqual(tool["toolset"], "fai_internal")
        self.assertEqual(tool["schema"]["parameters"]["required"], ["task"])
        self.assertEqual(len(tool["schema"]["parameters"]["properties"]["task"]["oneOf"]), 2)

    def test_client_tools_fail_closed_without_browser_identity(self):
        self.assertEqual(PLUGIN._client_handler("issue.create")({}, session_id="s1"),
                         '{"error": "authenticated_browser_identity_required"}')

    def test_role_run_session_cannot_be_promoted_without_receipt_binding(self):
        self.assertEqual(PLUGIN._handler("project_item.stage")({}, session_id="browser:unbound"),
            '{"error": "authenticated_message_identity_required"}')

    def test_exact_role_run_session_is_forwarded_for_server_side_receipt_resolution(self):
        captured = {}
        original = PLUGIN._post
        PLUGIN._post = lambda profile, source, action: captured.update(
            profile=profile, source=source, action=action) or '{"status":"completed"}'
        session_id = "browser:" + "a" * 64
        try:
            result = PLUGIN._handler("project_item.stage")(
                {"itemId": "PVTI_1", "issueId": "42", "expectedVersion": "v1", "stage": "QA"},
                session_id=session_id)
        finally:
            PLUGIN._post = original
        self.assertEqual(result, '{"status":"completed"}')
        self.assertEqual(captured["profile"], "internal")
        self.assertEqual(captured["source"], {"provider": "agent-role-run", "sessionId": session_id})

    def test_repository_tool_requires_receipt_and_returns_typed_retry_when_socket_is_absent(self):
        handler = PLUGIN._repository_handler("prepare")
        blocked = json.loads(handler({}, session_id="telegram-session"))
        self.assertEqual((blocked["status"], blocked["code"]), ("blocked", "authorization_denied"))
        retry = json.loads(handler({}, session_id="browser:" + "a" * 64))
        self.assertEqual((retry["status"], retry["code"]), ("retry", "bridge_unavailable"))

    def test_repository_tool_allows_bounded_time_for_initial_checkout(self):
        observed = []
        body = b'{"status":"prepared"}'

        class Socket:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def settimeout(self, timeout): observed.append(timeout)
            def connect(self, _path): return None
            def sendall(self, _value): return None
            def recv(self, _size):
                if getattr(self, "read", False): return b""
                self.read = True
                return b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n" + body

        original = PLUGIN.socket.socket
        PLUGIN.socket.socket = lambda *_args, **_kwargs: Socket()
        try:
            result = json.loads(PLUGIN._repository_handler("prepare")(
                {}, session_id="browser:" + "a" * 64))
        finally:
            PLUGIN.socket.socket = original
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(observed, [180])

    def test_executor_tool_uses_runtime_session_and_never_caller_identity(self):
        sent = []
        body = json.dumps({"status": "completed", "output": "done", "executorReceipt": {}}).encode()

        class Socket:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def settimeout(self, _timeout): return None
            def connect(self, path): self.path = path
            def sendall(self, value): sent.append(value)
            def recv(self, _size):
                if getattr(self, "read", False): return b""
                self.read = True
                return b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n" + body

        original = PLUGIN.socket.socket
        PLUGIN.socket.socket = lambda *_args, **_kwargs: Socket()
        session = "browser:" + "b" * 64
        try:
            result = json.loads(PLUGIN._executor_handler({"receiptReference": "attacker", "executorId": "codex-cli",
                "model": "gpt-5.6-terra", "effort": "medium", "prompt": "Implement"}, session_id=session))
        finally:
            PLUGIN.socket.socket = original
        request_body = json.loads(sent[0].split(b"\r\n\r\n", 1)[1])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(request_body["payload"]["receiptReference"], session)
        self.assertNotEqual(request_body["payload"]["receiptReference"], "attacker")


if __name__ == "__main__":
    unittest.main()
