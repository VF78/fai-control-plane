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
        self.assertEqual(len(context.tools), 3)
        self.assertEqual({tool["toolset"] for tool in context.tools}, {"fai_internal"})
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

    def test_role_run_context_is_one_thin_codex_execution(self):
        context = Context()
        PLUGIN.register(context)
        result = context.hooks["pre_llm_call"](
            session_id="browser:" + "a" * 64, platform="api_server"
        )
        protocol = result["context"]
        self.assertIn("exactly one foreground non-interactive Codex CLI", protocol)
        self.assertIn("stable issue worktree under /opt/data/work/items", protocol)
        self.assertIn("codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral", protocol)
        self.assertIn("Give Codex only the issue URL, role, constraints, acceptance criteria", protocol)
        self.assertIn("send the proposed plan to Telegram for confirmation, and wait", protocol)
        self.assertIn("Worker task payloads never carry approval material", protocol)
        self.assertIn("missing acceptance/risk checks", protocol)
        self.assertIn("one localized low-risk defect", protocol)
        self.assertIn("returns Dev rework", protocol)
        self.assertIn("Reuse the issue branch/worktree/PR", protocol)
        self.assertIn("Never duplicate an issue or PR", protocol)
        self.assertIn("directly with gh", protocol)
        self.assertIn("Never ask Control Plane to proxy", protocol)
        self.assertIn("decision, execution, outcome, transition, reason, evidence", protocol)
        self.assertIn("add no prose or Markdown", protocol)

    def test_non_role_api_session_gets_no_project_protocol(self):
        context = Context()
        PLUGIN.register(context)
        self.assertIsNone(context.hooks["pre_llm_call"](
            session_id="browser:not-bound", platform="api_server"
        ))

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
            result = PLUGIN._handler("source.add")({"name": "Note", "content": "Observed"}, session_id="s1")
        finally:
            PLUGIN._post = original
        self.assertEqual(result, '{"status":"completed"}')
        self.assertEqual(captured["source"]["userId"], "96211907")
        self.assertEqual(captured["source"]["updateId"], "77")
        self.assertNotIn("userId", captured["action"])

    def test_only_control_plane_owned_tools_are_registered(self):
        context = Context()
        PLUGIN.register(context)
        names = {tool["name"] for tool in context.tools}
        self.assertEqual(names, {"fai_project_execution_mode", "fai_source_add", "fai_approval_decide"})
        self.assertFalse(any("issue" in name or "project_item" in name or "process_start" in name
                             for name in names))

if __name__ == "__main__":
    unittest.main()
