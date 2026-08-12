import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ENTRYPOINT = Path(__file__).with_name("hermes_no_tools_orchestrator.py")
SPEC = importlib.util.spec_from_file_location("hermes_no_tools_orchestrator", ENTRYPOINT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HermesNoToolsOrchestratorTest(unittest.TestCase):
    def test_auxiliary_call_has_exact_empty_tools_without_agent_bootstrap(self) -> None:
        observed = {}

        def call_llm(**kwargs):
            observed.update(kwargs)
            message = types.SimpleNamespace(content='{"schemaVersion":1}')
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])

        agent = types.ModuleType("agent")
        auxiliary = types.ModuleType("agent.auxiliary_client")
        auxiliary.call_llm = call_llm
        agent.auxiliary_client = auxiliary
        with patch.dict(sys.modules, {"agent": agent, "agent.auxiliary_client": auxiliary}, clear=False):
            output = MODULE.run_planner(
                {"model": "bounded-model"},
                {"provider": "bounded-provider", "base_url": "https://provider.invalid/v1",
                 "api_key": None, "api_mode": "chat_completions"},
                '{"stepIds":["step.inspect_scope"]}',
            )
        self.assertEqual(output, '{"schemaVersion":1}')
        self.assertEqual(observed["tools"], [])
        self.assertEqual(observed["messages"][0]["content"], MODULE.SYSTEM_PROMPT)
        self.assertNotIn("run_agent", sys.modules)
        self.assertNotIn("agent.agent_init", sys.modules)
        self.assertNotIn("agent.context_compressor", sys.modules)
        self.assertNotIn("agent.memory_manager", sys.modules)
        self.assertNotIn("hermes_cli.plugins", sys.modules)
        self.assertNotIn("tools.mcp_tool", sys.modules)
        source = ENTRYPOINT.read_text(encoding="utf-8")
        self.assertNotIn("AIAgent", source)
        self.assertNotIn("from run_agent import", source)

    def test_forbidden_agent_bootstrap_fails_closed(self) -> None:
        with patch.dict(sys.modules, {"agent.context_compressor": types.ModuleType(
                "agent.context_compressor")}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "agent_bootstrap_loaded"):
                MODULE.assert_no_agent_bootstrap()


if __name__ == "__main__":
    unittest.main()
