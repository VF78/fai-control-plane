import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse


def _target():
    repository = urlparse(os.environ.get("FCP_PROJECT_REPOSITORY_URL", ""))
    tracker = urlparse(os.environ.get("FCP_PROJECT_TRACKER_URL", ""))
    repository_match = re.fullmatch(r"/([^/]+)/([^/]+)/?", repository.path)
    tracker_match = re.fullmatch(r"/users/([^/]+)/projects/([1-9][0-9]*)/?", tracker.path)
    if (repository.scheme, repository.netloc) != ("https", "github.com") or repository_match is None:
        raise ValueError("project_repository_unavailable")
    if (tracker.scheme, tracker.netloc) != ("https", "github.com") or tracker_match is None:
        raise ValueError("project_tracker_unavailable")
    if repository_match.group(1).lower() != tracker_match.group(1).lower():
        raise ValueError("project_binding_mismatch")
    return repository_match.group(1), repository_match.group(2), tracker_match.group(2)


def _run(arguments, environment):
    result = subprocess.run(arguments, env=environment, text=True, capture_output=True, timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError("github_command_failed")
    return result.stdout.strip()


def report_project_issue(args, **_kwargs):
    title = str(args.get("title", "")).strip()
    details = str(args.get("details", "")).strip()
    kind = str(args.get("kind", "issue"))
    if not 5 <= len(title) <= 200 or not 1 <= len(details) <= 10000 or kind not in {"issue", "bug"}:
        return json.dumps({"ok": False, "error": "invalid_issue"})
    try:
        owner, repository, project_number = _target()
        token = Path(os.environ.get("HERMES_GITHUB_REPOSITORY_TOKEN_FILE", "")).read_text().strip()
        if not 20 <= len(token) <= 512 or any(character.isspace() for character in token):
            raise ValueError("github_credential_unavailable")
        environment = {**os.environ, "GH_TOKEN": token, "GITHUB_TOKEN": token}
        issue_title = f"[BUG] {title}" if kind == "bug" else title
        issue_url = _run(["gh", "issue", "create", "--repo", f"{owner}/{repository}", "--title", issue_title,
                          "--body", details], environment).splitlines()[-1]
        if not re.fullmatch(r"https://github\.com/[^/]+/[^/]+/issues/[1-9][0-9]*", issue_url):
            raise RuntimeError("issue_reference_invalid")
        _run(["gh", "project", "item-add", project_number, "--owner", owner, "--url", issue_url], environment)
        return json.dumps({"ok": True, "issue_url": issue_url})
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return json.dumps({"ok": False, "error": "issue_creation_failed"})


def register(ctx):
    ctx.register_tool(
        name="report_project_issue",
        toolset="client_issue",
        schema={
            "name": "report_project_issue",
            "description": "Create a new issue or bug reported in this client conversation and add it to the bound project task tracker.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Concise factual issue title."},
                    "details": {"type": "string", "description": "Problem details and reproduction facts supplied by the client."},
                    "kind": {"type": "string", "enum": ["issue", "bug"]},
                },
                "required": ["title", "details", "kind"],
            },
        },
        handler=report_project_issue,
        description="Create one new client-reported issue in the bound project.",
    )
