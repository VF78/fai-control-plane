#!/usr/bin/env python3
"""Pinned Hermes 0.18.2 no-tools orchestration entrypoint.

This process may select only server-provided identifiers. It cannot execute a
tool or create commands for the Codex executor. Stdout is reserved for one JSON
object; failures are intentionally terse and never include provider details.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

EXPECTED_VERSION = "0.18.2"
MAX_INPUT_BYTES = 192 * 1024
MAX_OUTPUT_CHARS = 24 * 1024
FORBIDDEN_BOOTSTRAP_MODULES = (
    "run_agent",
    "agent.agent_init",
    "agent.context_compressor",
    "agent.memory_manager",
    "hermes_cli.plugins",
    "tools.mcp_tool",
)
SYSTEM_PROMPT = (
    "You are a bounded orchestration planner. Return exactly one JSON object and no markdown. "
    "Select one supplied strategy, order every supplied step ID exactly once, select every supplied "
    "check ID and risk-control ID exactly once. Never invent or emit commands, arguments, filesystem "
    "paths, provider identifiers, external identifiers, secret references, or free-form instructions. "
    "Echo the supplied taskPacketId, taskPacketHash, and workOrderHash exactly. Required keys: "
    "schemaVersion, orchestrator, executor, taskPacketId, taskPacketHash, workOrderHash, strategy, "
    "orderedStepIds, selectedCheckIds, selectedRiskControlIds. schemaVersion=1, "
    "orchestrator=hermes, executor=codex-cli."
)


def fail(code: str) -> "NoReturn":
    raise RuntimeError(code)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def load_contract() -> tuple[dict[str, Any], dict[str, Any]]:
    expected = os.environ.get("FCP_HERMES_EXPECTED_VERSION", "")
    if expected != EXPECTED_VERSION or importlib.metadata.version("hermes-agent") != expected:
        fail("version_mismatch")
    home = Path(os.environ.get("HERMES_HOME", ""))
    config_path = home / "config.yaml"
    if not home.is_absolute() or Path(os.environ.get("HOME", "")) != home or Path.home() != home or \
       not config_path.is_file() or config_path.is_symlink():
        fail("config_path")
    digest = hashlib.sha256(config_path.read_bytes()).hexdigest()
    if digest != os.environ.get("FCP_HERMES_CONFIG_SHA256", ""):
        fail("config_hash")

    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider

    config = load_config()
    agent_config = config.get("agent")
    platform_toolsets = config.get("platform_toolsets")
    plugins = config.get("plugins")
    mcp_servers = config.get("mcp_servers")
    if not isinstance(agent_config, dict) or agent_config.get("disabled_toolsets") != ["*"] or \
       not isinstance(platform_toolsets, dict) or platform_toolsets.get("cli") != [] or \
       (plugins not in (None, {}) and (not isinstance(plugins, dict) or plugins.get("enabled") != [])) or \
       mcp_servers not in (None, {}):
        fail("customization_posture")
    model_config = config.get("model")
    if not isinstance(model_config, dict):
        fail("model_config")
    model = model_config.get("default") or model_config.get("model")
    provider = model_config.get("provider")
    if not isinstance(model, str) or not model.strip() or not isinstance(provider, str) or not provider.strip():
        fail("model_binding")
    runtime = resolve_runtime_provider(requested=provider.strip(), target_model=model.strip())
    return {"model": model.strip(), "provider": provider.strip(), "configSha256": digest}, runtime


def assert_no_agent_bootstrap() -> None:
    if any(name == forbidden or name.startswith(forbidden + ".")
           for name in sys.modules for forbidden in FORBIDDEN_BOOTSTRAP_MODULES):
        fail("agent_bootstrap_loaded")


def run_planner(binding: dict[str, Any], runtime: dict[str, Any], bounded_input: str, *,
                system_prompt: str = SYSTEM_PROMPT, max_tokens: int = 2_048,
                max_output_chars: int = MAX_OUTPUT_CHARS) -> str:
    if not isinstance(system_prompt, str) or not system_prompt or not isinstance(max_tokens, int) or \
       max_tokens < 1 or max_tokens > 16_384 or not isinstance(max_output_chars, int) or \
       max_output_chars < 1 or max_output_chars > 300 * 1024:
        fail("planner_bounds")
    assert_no_agent_bootstrap()
    from agent.auxiliary_client import call_llm
    assert_no_agent_bootstrap()
    response = call_llm(
        provider=runtime.get("provider"),
        model=binding["model"],
        base_url=runtime.get("base_url"),
        api_key=runtime.get("api_key"),
        api_mode=runtime.get("api_mode"),
        messages=[{"role": "system", "content": system_prompt},
                  {"role": "user", "content": bounded_input}],
        max_tokens=max_tokens,
        tools=[],
        timeout=45.0,
        extra_body={},
    )
    assert_no_agent_bootstrap()
    try:
        output = response.choices[0].message.content
    except (AttributeError, IndexError, TypeError):
        fail("model_output")
    if not isinstance(output, str) or not output.strip() or len(output) > max_output_chars:
        fail("model_output")
    return output.strip()


def parse_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) == 0 or len(raw) > MAX_INPUT_BYTES:
        fail("input_size")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {
        "schemaVersion", "taskPacketId", "taskPacketHash", "workOrderHash", "workOrder"
    }:
        fail("input_schema")
    work_order = request["workOrder"]
    if request["schemaVersion"] != 1 or not isinstance(work_order, dict):
        fail("input_schema")
    if hashlib.sha256(canonical_json(work_order).encode()).hexdigest() != request["workOrderHash"]:
        fail("work_order_hash")
    packet = work_order.get("taskPacket")
    if not isinstance(packet, dict) or packet.get("id") != request["taskPacketId"] or packet.get("sha256") != request["taskPacketHash"]:
        fail("packet_identity")
    return request


def main() -> int:
    logging.disable(logging.CRITICAL)
    binding, runtime = load_contract()
    assert_no_agent_bootstrap()
    if sys.argv[1:] == ["--preflight"]:
        from agent.auxiliary_client import call_llm as _call_llm  # noqa: F401
        assert_no_agent_bootstrap()
        print(canonical_json({"status": "ready", "version": EXPECTED_VERSION,
                              "engine": "hermes_auxiliary_client", "agentBootstrap": False,
                              "toolArgumentCount": 0, "configSha256": binding["configSha256"]}))
        return 0
    if sys.argv[1:]:
        fail("arguments")
    request = parse_request()
    orchestration = request["workOrder"].get("orchestration")
    if not isinstance(orchestration, dict):
        fail("orchestration_schema")
    bounded_input = canonical_json({
        "taskPacketId": request["taskPacketId"],
        "taskPacketHash": request["taskPacketHash"],
        "workOrderHash": request["workOrderHash"],
        "strategyOptions": orchestration.get("strategyOptions"),
        "stepIds": orchestration.get("stepIds"),
        "checkIds": [item.get("id") for item in orchestration.get("checkCandidates", [])
                     if isinstance(item, dict)],
        "riskControlIds": orchestration.get("riskControlIds"),
    })
    sys.stdout.write(run_planner(binding, runtime, bounded_input) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("hermes-orchestrator: fail-closed\n")
        raise SystemExit(1)
