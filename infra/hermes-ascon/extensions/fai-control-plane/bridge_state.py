"""Short-lived native message identity, promoted only after Hermes authorization."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from threading import Lock
from time import monotonic

_TTL_SECONDS = 120.0
_MAX_PENDING = 128
_lock = Lock()
_pending = deque(maxlen=_MAX_PENDING)
_sessions: dict[str, tuple[float, dict[str, str]]] = {}


def _purge(now: float) -> None:
    while _pending and now - _pending[0][0] > _TTL_SECONDS:
        _pending.popleft()
    expired = [key for key, (created, _) in _sessions.items() if now - created > _TTL_SECONDS]
    for key in expired:
        _sessions.pop(key, None)


def stage(*, platform: str, user_id: str, chat_id: str, update_id: str, message_id: str) -> None:
    now = monotonic()
    value = {
        "provider": platform,
        "userId": user_id,
        "chatId": chat_id,
        "updateId": update_id,
        "messageId": message_id,
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    with _lock:
        _purge(now)
        _pending.append((now, value))


def promote(*, platform: str, user_id: str, chat_id: str, session_id: str) -> bool:
    now = monotonic()
    with _lock:
        _purge(now)
        for index in range(len(_pending) - 1, -1, -1):
            created, value = _pending[index]
            if value["provider"] == platform and value["userId"] == user_id and value["chatId"] == chat_id:
                del _pending[index]
                _sessions[session_id] = (created, value)
                return True
    return False


def resolve(session_id: str) -> dict[str, str] | None:
    now = monotonic()
    with _lock:
        _purge(now)
        value = _sessions.get(session_id)
        return None if value is None else dict(value[1])


def reset_for_test() -> None:
    with _lock:
        _pending.clear()
        _sessions.clear()
