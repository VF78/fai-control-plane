"""Persist an existing project Codex CLI OAuth session for Hermes itself."""

from hermes_cli.auth import _import_codex_cli_tokens, _save_codex_tokens


tokens = _import_codex_cli_tokens()
if tokens is None:
    raise SystemExit("project_codex_oauth_unavailable")
_save_codex_tokens(tokens)
