"""Post-authorization identity promotion for native Control Plane tools."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _state():
    existing = sys.modules.get("fai_control_plane_bridge_state")
    if existing is not None:
        return existing
    path = Path("/opt/data/plugins/fai-control-plane/bridge_state.py")
    spec = importlib.util.spec_from_file_location("fai_control_plane_bridge_state", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("bridge_state_unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules["fai_control_plane_bridge_state"] = module
    spec.loader.exec_module(module)
    return module


async def handle(event_type: str, context: dict) -> None:
    if event_type != "agent:start" or context.get("platform") != "telegram":
        return
    values = {key: str(context.get(key) or "") for key in ("user_id", "chat_id", "session_id")}
    if all(values.values()):
        _state().promote(platform="telegram", user_id=values["user_id"], chat_id=values["chat_id"],
                         session_id=values["session_id"])
