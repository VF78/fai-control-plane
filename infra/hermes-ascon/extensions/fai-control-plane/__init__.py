"""Native, provider-neutral action tools for the ASCON Control Plane."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from . import bridge_state

sys.modules.setdefault("fai_control_plane_bridge_state", bridge_state)

_CHAT_ID = "-5540760630"
_USER_IDS = frozenset({"96211907", "355724486"})
_ACTION_URL_PATH = "/api/hermes/conversation-actions"
_ROLE_RUN_PROTOCOL = """Project task protocol:
1. You are this project's persistent PM, Developer, QA and DevOps orchestrator and executor. The compact request names one exact GitHub item, role and configured CLI/model/reasoning route. Read the issue, comments, Project fields, linked PR and current repository facts directly with git/gh before acting; never rely on stale chat history.
2. If the issue is incomplete, do the PM work yourself: analyze it, update the same issue with the missing scope and acceptance criteria, send the proposed plan to Telegram for confirmation, and wait. This is not a technical blocker. After confirmation, or when the issue is already complete, follow the requested role and route. For repository work invoke exactly one foreground non-interactive Codex CLI in the stable issue worktree under /opt/data/work/items with `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral`; this non-root project container is the external sandbox. Give Codex only the issue URL, role, constraints, acceptance criteria and the smallest necessary project context; Codex reads AGENTS.md and relevant files itself.
3. Reuse the issue branch/worktree/PR after retry or QA. Developer performs focused checks. QA reviews the current PR and missing acceptance/risk checks; it may fix one localized low-risk defect, otherwise returns Dev rework. Never duplicate an issue or PR. Never merge, release, deploy or touch production unless Vladimir confirmed that exact action through the trusted UI or Telegram dialogue. Worker task payloads never carry approval material.
4. Create/update issues and change the same Project item directly with gh. Confirm GitHub readback. Never ask Control Plane to proxy a repository or Project command. On an unresolved blocker keep the current stage.
5. Return only one compact fai.agent-executor-result.v1 JSON object with decision, execution, outcome, transition, reason, evidence and HTTPS deliverables; add no prose or Markdown. Report the CLI/model/reasoning actually used and the GitHub Project transition you verified. Approval material is never delivered in the task request."""


def _pre_dispatch(event, **_kwargs):
    source = getattr(event, "source", None)
    platform = str(getattr(getattr(source, "platform", None), "value", getattr(source, "platform", "")))
    if platform != "telegram":
        return None
    user_id = str(getattr(source, "user_id", ""))
    chat_id = str(getattr(source, "chat_id", ""))
    update_id = str(getattr(event, "platform_update_id", ""))
    message_id = str(getattr(event, "message_id", ""))
    if chat_id != _CHAT_ID or user_id not in _USER_IDS or not update_id.isdigit() or not message_id.isdigit():
        return {"action": "skip", "reason": "identity_denied"}
    bridge_state.stage(platform=platform, user_id=user_id, chat_id=chat_id,
                       update_id=update_id, message_id=message_id)
    return {"action": "allow"}


def _bridge_url() -> str:
    value = os.environ.get("FCP_CONVERSATION_ACTION_URL", "")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path != _ACTION_URL_PATH or parsed.query or parsed.fragment:
        raise ValueError("bridge_url_invalid")
    return value


def _token(profile: str) -> str:
    value = Path(f"/opt/data/profiles/{profile}/bridge-token").read_text(encoding="utf-8").strip()
    if not 32 <= len(value) <= 512 or "\x00" in value:
        raise ValueError("bridge_token_invalid")
    return value


def _post(profile: str, source: dict[str, str], action: dict, response_limit: int = 4_096) -> str:
    payload = json.dumps({"source": source, "action": action}, separators=(",", ":")).encode("utf-8")
    if len(payload) > 32_000:
        return json.dumps({"error": "bridge_payload_invalid"})
    request = Request(_bridge_url(), data=payload, method="POST", headers={
        "authorization": f"Bearer {_token(profile)}", "content-type": "application/json",
    })
    try:
        with urlopen(request, timeout=15) as response:
            body = response.read(response_limit + 1)
            if len(body) > response_limit:
                raise ValueError("bridge_response_too_large")
            value = json.loads(body)
            if response.status not in (200, 202) or value.get("status") not in ("completed", "duplicate"):
                raise ValueError("bridge_response_invalid")
            return json.dumps(value, separators=(",", ":"))
    except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError):
        return json.dumps({"error": "control_plane_unavailable"})


def _context_hook(state, **kwargs):
    session_id = str(kwargs.get("session_id") or "")
    platform_value = kwargs.get("platform")
    platform = str(getattr(platform_value, "value", platform_value or ""))
    if platform == "api_server" and re.fullmatch(r"browser:[a-f0-9]{64}", session_id):
        return {"context": _ROLE_RUN_PROTOCOL}
    if platform != "telegram":
        return None
    source = bridge_state.resolve(session_id)
    if source is None or source.get("provider") != "telegram":
        return {"context": "Project context is unavailable. Do not mutate project systems until identity and current context are confirmed."}
    try:
        cached_version = str(state.get("project_context_version", "") or "")
        cached_capsule = str(state.get("project_context_capsule", "") or "")
    except (RuntimeError, ValueError, OSError):
        cached_version = ""
        cached_capsule = ""
    if not re.fullmatch(r"[a-f0-9]{64}", cached_version):
        cached_version = ""
    if not cached_capsule or "\x00" in cached_capsule or len(cached_capsule.encode("utf-8")) > 4_000:
        cached_capsule = ""
    action = {"type": "project_context.read", "ifVersion": cached_version or None}
    raw = _post("internal", source, action, response_limit=8_192)
    try:
        result = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        result = {"error": "control_plane_unavailable"}
    version = str(result.get("version") or "") if isinstance(result, dict) else ""
    status = result.get("status") if isinstance(result, dict) else None
    if status == "completed" and re.fullmatch(r"[a-f0-9]{64}", version):
        capsule = str(result.get("capsule") or "")
        if capsule and "\x00" not in capsule and len(capsule.encode("utf-8")) <= 4_000:
            try:
                state.set("project_context_version", version)
                state.set("project_context_capsule", capsule)
            except (RuntimeError, ValueError, OSError):
                pass
            return {"context": f"Active project context {version[:12]} (current):\n{capsule}"}
    if status == "duplicate" and version == cached_version and cached_capsule:
        return {"context": f"Active project context {cached_version[:12]} (current):\n{cached_capsule}"}
    if cached_capsule:
        return {"context": f"WARNING: project context service is unavailable; cached version {cached_version[:12]} may be stale. Do not mutate project systems until live facts are re-read.\n{cached_capsule}"}
    return {"context": "Project context is unavailable. Do not mutate project systems until the current context is loaded from Control Plane."}


def _handler(action_type: str):
    def handle(args: dict, **kwargs) -> str:
        session_id = str(kwargs.get("session_id") or "")
        source = bridge_state.resolve(session_id)
        if source is None or source.get("provider") != "telegram":
            return json.dumps({"error": "authenticated_message_identity_required"})
        action = {"type": action_type, **args}
        return _post("internal", source, action)
    return handle


def _schema(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"name": name, "description": description, "parameters": {
        "type": "object", "properties": properties, "required": required, "additionalProperties": False,
    }}


_TEXT = {"type": "string", "minLength": 1, "maxLength": 4000}
_ID = {"type": "string", "minLength": 1, "maxLength": 256}
_TOOLS = (
    ("fai_project_execution_mode", "project.execution.mode",
     "Enable or stop project autonomous execution. This is separate from starting one task.",
     {"mode": {"type": "string", "enum": ["manual", "autonomous"]}}, ["mode"]),
    ("fai_source_add", "source.add", "Attach bounded source context to the project.",
     {"name": {"type": "string", "minLength": 1, "maxLength": 200}, "content": _TEXT}, ["name", "content"]),
    ("fai_approval_decide", "approval.decide", "Record an explicit human decision for an exact approval target.",
     {"approvalId": _ID, "kind": {"type": "string", "enum": ["plan", "internal_operation", "production", "acceptance", "client_uat"]},
      "targetReference": _ID, "decision": {"type": "string", "enum": ["approved", "rejected"]}},
     ["approvalId", "kind", "targetReference", "decision"]),
)


def register(ctx) -> None:
    for name, action_type, description, properties, required in _TOOLS:
        ctx.register_tool(name=name, toolset="fai_internal", schema=_schema(name, description, properties, required),
                          handler=_handler(action_type))
    ctx.register_hook("pre_gateway_dispatch", _pre_dispatch)
    ctx.register_hook("pre_llm_call", lambda **kwargs: _context_hook(ctx.state, **kwargs))
