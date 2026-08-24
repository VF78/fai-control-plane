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


def _post(profile: str, source: dict[str, str], action: dict) -> str:
    payload = json.dumps({"source": source, "action": action}, separators=(",", ":")).encode("utf-8")
    if len(payload) > 32_000:
        return json.dumps({"error": "bridge_payload_invalid"})
    request = Request(_bridge_url(), data=payload, method="POST", headers={
        "authorization": f"Bearer {_token(profile)}", "content-type": "application/json",
    })
    try:
        with urlopen(request, timeout=15) as response:
            body = response.read(4_097)
            if len(body) > 4_096:
                raise ValueError("bridge_response_too_large")
            value = json.loads(body)
            if response.status not in (200, 202) or value.get("status") not in ("completed", "duplicate"):
                raise ValueError("bridge_response_invalid")
            return json.dumps(value, separators=(",", ":"))
    except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError):
        return json.dumps({"error": "control_plane_unavailable"})


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
    for name, action_type, description, properties, required in (_TOOLS[1], _TOOLS[3]):
        client_name = name.replace("fai_", "fai_client_", 1)
        ctx.register_tool(name=client_name, toolset="fai_client",
                          schema=_schema(client_name, description, properties, required),
                          handler=_client_handler(action_type))
    ctx.register_hook("pre_gateway_dispatch", _pre_dispatch)
