import importlib.util
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

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_hook(self, name, handler):
        self.hooks[name] = handler


class PluginTest(unittest.TestCase):
    def setUp(self):
        PLUGIN.bridge_state.reset_for_test()

    def test_registers_seven_bounded_tools_and_identity_hook(self):
        context = Context()
        PLUGIN.register(context)
        self.assertEqual(len(context.tools), 7)
        self.assertEqual({tool["toolset"] for tool in context.tools}, {"fai_internal", "fai_client"})
        self.assertIn("pre_gateway_dispatch", context.hooks)

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

    def test_client_tools_fail_closed_without_browser_identity(self):
        self.assertEqual(PLUGIN._client_handler("issue.create")({}, session_id="s1"),
                         '{"error": "authenticated_browser_identity_required"}')


if __name__ == "__main__":
    unittest.main()
