#!/bin/sh
set -eu

codex login --device-auth
exec /opt/hermes/.venv/bin/python /usr/local/lib/fai/import-codex-oauth.py
