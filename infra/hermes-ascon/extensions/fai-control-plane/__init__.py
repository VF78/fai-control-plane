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
_ROLE_RUN_PROTOCOL = """Agent role-run protocol (mandatory):
1. The JSON request is the receipt-bound routing envelope. Classify once from request.role, request.projectItem.title, constraints and acceptance criteria; resolve exactly one route from request.routing.policy. Unknown or unavailable routes are rejected.
2. A direct-agent route is only for bounded project management or an exact approved operation. Never use it for repository implementation, QA, architecture or critical engineering decisions.
3. A CLI route is exactly one foreground terminal call with timeout 1800 and no PTY, containing exactly one non-interactive codex exec. Do not load skills, inspect the repository in Hermes, delegate, start background work, poll, create a second plan, repeat checks or review Codex output.
4. The persistent /opt/data/work/project checkout is worktree metadata only. In that single terminal call fetch request.repository.defaultBranchSha, create a fresh detached worktree at /opt/data/work/runs/<64-hex-correlation-id>, and run codex exec there with the route's exact --model and model_reasoning_effort, --sandbox workspace-write, --output-schema /opt/fai/agent-executor-result.schema.json and -o. The compact prompt contains only the role, Project item title/URL, pinned base, exact receipt/transition fields, constraints and acceptance criteria. Codex reads AGENTS.md, the referenced GitHub issue and only relevant repository files itself; never paste chat history, repository documents or the full source capsule into the prompt.
5. Developer Codex performs one implementation pass, focused self-checks, commit, review-branch push and PR creation. QA Codex reviews that PR and existing evidence, runs only missing acceptance/risk checks, records QA evidence and either accepts or requests developer rework; it does not repeat an unchanged full test suite. Merge, release, deploy and production remain forbidden.
6. Capture the schema result, then remove the temporary worktree and result/progress files in the same terminal call. Return Codex's JSON unchanged. Do not make a second gh query or reinterpret a valid result. A real terminal/contract failure is a rejected result targeting the configured rework stage, or the current stage when none exists.
7. Never mutate Project status; Control Plane validates one result, applies one configured transition with provider readback, and starts the next configured role once."""


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
        if source is None and re.fullmatch(r"browser:[a-f0-9]{64}", session_id):
            source = {"provider": "agent-role-run", "sessionId": session_id}
        if source is None or source.get("provider") not in ("telegram", "agent-role-run"):
            return json.dumps({"error": "authenticated_message_identity_required"})
        action = {"type": action_type, **args}
        return _post("internal", source, action)
    return handle


def _client_handler(_action_type: str):
    def handle(_args: dict, **_kwargs) -> str:
        return json.dumps({"error": "authenticated_browser_identity_required"})
    return handle


def _schema(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"name": name, "description": description, "parameters": {
        "type": "object", "properties": properties, "required": required, "additionalProperties": False,
    }}


_TEXT = {"type": "string", "minLength": 1, "maxLength": 4000}
_ID = {"type": "string", "minLength": 1, "maxLength": 256}
_TOOLS = (
    ("fai_project_facts", "project_facts.read", "Read current provider-native project facts.", {}, []),
    ("fai_process_start", "process.start",
     "For a Telegram task intent, create and start one monitored Hermes process chain, or start one exact existing Project item.",
     {"task": {"oneOf": [
         {"type": "object", "properties": {"kind": {"const": "create"},
          "title": {"type": "string", "minLength": 1, "maxLength": 160}, "statement": _TEXT},
          "required": ["kind", "title", "statement"], "additionalProperties": False},
         {"type": "object", "properties": {"kind": {"const": "existing"}, "itemId": _ID},
          "required": ["kind", "itemId"], "additionalProperties": False}
     ]}}, ["task"]),
    ("fai_issue_create", "issue.create", "Create one issue in the bound repository and Project.",
     {"title": {"type": "string", "minLength": 1, "maxLength": 160}, "statement": _TEXT}, ["title", "statement"]),
    ("fai_issue_update", "issue.update", "Update one exact issue and verify the provider result.",
     {"itemId": _ID, "issueId": _ID, "expectedVersion": _ID,
      "operation": {"type": "string", "enum": ["title", "body", "state"]}, "value": _TEXT},
     ["itemId", "issueId", "expectedVersion", "operation", "value"]),
    ("fai_issue_clarify", "issue.clarify", "Add clarification to an exact issue version.",
     {"referenceId": _ID, "expectedVersion": _ID, "statement": _TEXT}, ["referenceId", "expectedVersion", "statement"]),
    ("fai_project_item_stage", "project_item.stage",
     "Change the stage of the exact GitHub Project item and verify the provider result. Done is approval-gated and unavailable here.",
     {"itemId": _ID, "issueId": _ID, "expectedVersion": _ID,
      "stage": {"type": "string", "enum": ["Backlog", "Ready", "In Dev", "QA", "Acceptance"]}},
     ["itemId", "issueId", "expectedVersion", "stage"]),
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
    for name, action_type, description, properties, required in (_TOOLS[2], _TOOLS[4]):
        client_name = name.replace("fai_", "fai_client_", 1)
        ctx.register_tool(name=client_name, toolset="fai_client",
                          schema=_schema(client_name, description, properties, required),
                          handler=_client_handler(action_type))
    ctx.register_hook("pre_gateway_dispatch", _pre_dispatch)
    ctx.register_hook("pre_llm_call", lambda **kwargs: _context_hook(ctx.state, **kwargs))
