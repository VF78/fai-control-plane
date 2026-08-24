import hashlib
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[3]


class DeploymentContractTest(unittest.TestCase):
    def test_web_mounts_only_root_produced_hermes_readiness_read_only(self):
        compose = (ROOT / "infra/production/compose.yaml").read_text()
        environment_file = ROOT / "infra/production/production.env.example"
        environment = environment_file.read_text()
        web = compose.split("  web:\n", 1)[1].split("  worker:\n", 1)[0]

        self.assertIn(
            "${FCP_HERMES_READINESS_HOST_DIR:?required}:/run/fai-readiness:ro",
            web,
        )
        self.assertIn(
            "FCP_HERMES_READINESS_HOST_DIR=/var/lib/fai-hermes-ascon/readiness\n",
            environment,
        )
        digest = hashlib.sha256(environment_file.read_bytes()).hexdigest()
        runbook = (ROOT / "docs/ops/PRODUCTION_RUNBOOK.md").read_text()
        self.assertIn(digest, runbook)

    def test_root_only_host_secrets_are_copied_then_process_drops_privileges(self):
        compose = (ROOT / "infra/production/compose.yaml").read_text()
        dockerfile = (ROOT / "infra/compose/Dockerfile").read_text()
        entrypoint = (ROOT / "infra/compose/container-entrypoint.sh").read_text()

        app = compose.split("x-app: &app", 1)[1].split(
            "x-database-environment:", 1
        )[0]
        postgres = compose.split("  postgres:", 1)[1].split("  migrate:", 1)[0]
        self.assertIn('user: "0:0"', app)
        self.assertIn(
            'ENTRYPOINT ["sh", "infra/compose/container-entrypoint.sh"]',
            dockerfile,
        )
        self.assertIn("RUN command -v setpriv >/dev/null", dockerfile)
        self.assertIn("      - postgres-password", postgres)
        self.assertNotIn("source-postgres-password", postgres)

        service_boundaries = {
            "migrate": "  bootstrap:",
            "bootstrap": "  web:",
            "web": "  worker:",
            "worker": "networks:",
        }
        for service, next_section in service_boundaries.items():
            section = compose.split(f"  {service}:\n", 1)[1].split(
                f"\n{next_section}", 1
            )[0]
            self.assertIn("target: source-postgres-password", section)
        self.assertIn('install -o node -g node -m 0400', entrypoint)
        self.assertIn("--reuid=node --regid=node --init-groups", entrypoint)
        self.assertIn("--no-new-privs --bounding-set=-all", entrypoint)

    def test_health_wait_survives_starting_under_errexit(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        start = script.index("wait_for_candidate_health() {")
        end = script.index("\n}\n\nnormalize_checkout_modes()", start) + 3
        health_wait = script[start:end]
        self.assertIn("if (( all_healthy )); then return 0; fi", health_wait)

        with tempfile.NamedTemporaryFile(mode="w") as poll_file:
            poll_file.write("0")
            poll_file.flush()
            harness = f"""\
set -euo pipefail
{health_wait}
compose_stub() {{ printf '%s\\n' candidate-container-id; }}
docker() {{
  poll=$(cat "$POLL_FILE"); poll=$((poll + 1)); printf '%s' "$poll" > "$POLL_FILE"
  if (( poll == 1 )); then printf '%s\\n' 'running starting'; else printf '%s\\n' 'running healthy'; fi
}}
sleep() {{ :; }}
compose=(compose_stub)
wait_for_candidate_health "$((SECONDS + 10))" postgres
test "$(cat "$POLL_FILE")" = 2
"""
            subprocess.run(
                ["bash", "-c", harness],
                check=True,
                env={"PATH": "/usr/bin:/bin", "POLL_FILE": poll_file.name},
                capture_output=True,
                text=True,
            )

    def test_active_preflight_accepts_only_healthy_or_cleanly_incident_stopped_worker(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        start = script.index("active_mvp_health() {")
        end = script.index("\n}\n\nactive_upstream_unchanged()", start) + 3
        active_health = script[start:end]
        harness = f"""\
set -euo pipefail
{active_health}
log() {{ printf '%s\n' "$1"; }}
curl() {{ :; }}
docker() {{
  container=${{@: -1}}
  if [[ "$container" == fai-control-plane-mvp-worker-1 ]]; then
    printf '%s\n' "$WORKER_INSPECT"
  elif [[ "$*" == *State.Health.Status* ]]; then
    printf '%s\n' healthy
  else
    printf '%s\n' running
  fi
}}
active_mvp_health
"""
        accepted = {
            "running healthy 0": "mode=running",
            "exited healthy 0": "mode=incident-stopped",
        }
        for worker_inspect, marker in accepted.items():
            with self.subTest(worker_inspect=worker_inspect):
                result = subprocess.run(["bash", "-c", harness], env={
                    "PATH": "/usr/bin:/bin", "WORKER_INSPECT": worker_inspect
                }, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(marker, result.stdout)
        for worker_inspect in ("running unhealthy 0", "exited healthy 1", "dead missing 0"):
            with self.subTest(worker_inspect=worker_inspect):
                result = subprocess.run(["bash", "-c", harness], env={
                    "PATH": "/usr/bin:/bin", "WORKER_INSPECT": worker_inspect
                }, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)

    def test_preflight_is_read_only_and_reports_resulting_digest(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        preflight_case = script.split('if [[ "$action" == preflight ]]', 1)[1].split(
            "fi", 1
        )[0]
        preflight = script.split("run_preflight() {", 1)[1].split("\n}\n", 1)[0]
        host_checks = script.split("check_host_contract() {", 1)[1].split(
            "\n}\n", 1
        )[0]

        self.assertIn("run_preflight", preflight_case)
        self.assertIn("exit 0", preflight_case)
        self.assertIn("resulting_config_sha256", preflight)
        self.assertIn("git ls-remote --exit-code", host_checks)
        for mutation in (
            "git fetch",
            "git merge",
            "docker compose up",
            "docker compose build",
            "install ",
            "mv -f",
            "systemctl reload",
        ):
            self.assertNotIn(mutation, preflight + host_checks + preflight_case)

    def test_private_release_bundle_is_bounded_and_verified(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        source = script.split("release_source() {", 1)[1].split("\n}\n", 1)[0]
        host_checks = script.split("check_host_contract() {", 1)[1].split(
            "\n}\n", 1
        )[0]

        self.assertIn("/tmp/fai-control-plane-*.bundle", source)
        self.assertIn("root:root:600", source)
        self.assertIn('git bundle verify "$bundle"', source)
        self.assertIn("source=$(release_source)", host_checks)
        self.assertIn('git ls-remote --exit-code "$source"', host_checks)
        self.assertIn('git fetch --no-tags "$release_source"', script)

    def test_environment_render_changes_only_release_and_bitrix_gate(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        start = script.index("render_target_environment() {")
        end = script.index("\n}\n\ncheck_host_contract()", start) + 3
        renderer = script[start:end]
        old = """A=one
FCP_RELEASE_COMMIT=old
MIDDLE=kept
BITRIX24_CLIENT_ACTIONS_ENABLED=true
Z=last
"""
        expected = """A=one
FCP_RELEASE_COMMIT=0123456789abcdef0123456789abcdef01234567
MIDDLE=kept
BITRIX24_CLIENT_ACTIONS_ENABLED=false
Z=last
"""
        with tempfile.NamedTemporaryFile(mode="w") as environment:
            environment.write(old)
            environment.flush()
            harness = f"""\
set -euo pipefail
fail() {{ printf '%s\\n' "$1" >&2; exit 1; }}
environment_file="$ENVIRONMENT_FILE"
release_commit=0123456789abcdef0123456789abcdef01234567
{renderer}
render_target_environment
"""
            result = subprocess.run(
                ["bash", "-c", harness],
                check=True,
                env={"PATH": "/usr/bin:/bin", "ENVIRONMENT_FILE": environment.name},
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.stdout, expected)

        without_gate = old.replace("BITRIX24_CLIENT_ACTIONS_ENABLED=true\n", "")
        with tempfile.NamedTemporaryFile(mode="w") as environment:
            environment.write(without_gate)
            environment.flush()
            result = subprocess.run(
                ["bash", "-c", harness],
                check=True,
                env={"PATH": "/usr/bin:/bin", "ENVIRONMENT_FILE": environment.name},
                capture_output=True,
                text=True,
            )
        self.assertEqual(
            result.stdout,
            expected.replace("BITRIX24_CLIENT_ACTIONS_ENABLED=false\n", "")
            + "BITRIX24_CLIENT_ACTIONS_ENABLED=false\n",
        )

    def test_deploy_fast_forwards_then_builds_before_atomic_environment_install(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        deploy = script[script.index("log 'deploy: fetching exact origin/main'") :]

        ordered = (
            'git fetch --no-tags "$release_source"',
            'git merge --ff-only "$release_commit"',
            '"${candidate_compose[@]}" build web',
            'mv -f "$temporary_environment" "$environment_file"',
            '"${compose[@]}" run --rm migrate',
            '"${compose[@]}" --profile bootstrap run --rm --no-deps bootstrap',
            '"${compose[@]}" up -d --no-deps web worker',
            "https://app.f-ai.studio/api/ready",
            "https://app.f-ai.studio/",
        )
        positions = [deploy.index(item) for item in ordered]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("git merge-base --is-ancestor HEAD", deploy)
        self.assertEqual(deploy.count('"${candidate_compose[@]}" build web'), 1)
        self.assertNotIn("build web worker", deploy)
        self.assertIn("prune_superseded_project_images", deploy)
        self.assertIn("docker builder prune -af", script)
        dockerfile = (ROOT / "infra/compose/Dockerfile").read_text()
        self.assertIn(
            "LABEL com.docker.compose.project=fai-control-plane-mvp",
            dockerfile,
        )
        self.assertIn("FCP_APPROVED_CONFIG_SHA256", deploy)
        self.assertIn("BITRIX24_CLIENT_ACTIONS_ENABLED=false", deploy)
        self.assertNotIn("switch_upstream", deploy)
        self.assertNotIn("systemctl reload nginx", deploy)
        self.assertNotIn('install -o root -g root -m 0644', deploy)
        self.assertNotIn("docker stop", deploy)
        self.assertNotIn(" down", deploy)

    def test_project_logs_are_bounded(self):
        compose = (ROOT / "infra/production/compose.yaml").read_text()

        self.assertIn("x-logging: &bounded-logging", compose)
        self.assertIn('max-size: "10m"', compose)
        self.assertIn('max-file: "3"', compose)
        self.assertEqual(compose.count("logging: *bounded-logging"), 2)


if __name__ == "__main__":
    unittest.main()
