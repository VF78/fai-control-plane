import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[3]


class DeploymentContractTest(unittest.TestCase):
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
        self.assertIn('exec setpriv', entrypoint)

    def test_candidate_health_wait_survives_starting_under_errexit(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        start = script.index("wait_for_candidate_health() {")
        end = script.index("\n}\n\ncandidate_listener_absent()", start) + 3
        health_wait = script[start:end]

        self.assertIn("if (( all_healthy )); then", health_wait)
        self.assertNotIn("(( all_healthy )) && return 0", health_wait)

        with tempfile.NamedTemporaryFile(mode="w") as poll_file:
            poll_file.write("0")
            poll_file.flush()
            harness = f"""\
set -euo pipefail
{health_wait}
compose_stub() {{
  printf '%s\\n' candidate-container-id
}}
docker() {{
  poll=$(cat "$POLL_FILE")
  poll=$((poll + 1))
  printf '%s' "$poll" > "$POLL_FILE"
  if (( poll == 1 )); then
    printf '%s\\n' 'running starting'
  else
    printf '%s\\n' 'running healthy'
  fi
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

    def test_stage_waits_for_candidate_health_and_cleans_up_failures(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        stage = script.split("  stage)", 1)[1].split("    ;;", 1)[0]
        cleanup = script.split("stage_exit_cleanup()", 1)[1].split(
            "trap stage_exit_cleanup", 1
        )[0]

        self.assertIn("candidate_health_deadline=$((SECONDS + 180))", stage)
        self.assertIn(
            'wait_for_candidate_health "$candidate_health_deadline" postgres', stage
        )
        self.assertIn(
            'wait_for_candidate_health "$candidate_health_deadline" postgres web worker',
            stage,
        )
        self.assertIn("exited|dead|'') return 1", script)
        self.assertIn("unhealthy|missing|'') return 1", script)
        self.assertLess(
            stage.index("stage_cleanup_required=1"),
            stage.index('"${compose[@]}" build'),
        )
        self.assertIn('"${compose[@]}" down', cleanup)
        self.assertNotIn(" down -v", cleanup)
        self.assertNotIn("--rmi", cleanup)
        self.assertIn("candidate_listener_absent", cleanup)
        self.assertIn("ss -H -ltn 'sport = :13010'", script)
        self.assertLess(
            script.rindex("protected_health || fail"),
            script.rindex("stage_cleanup_required=0"),
        )

    def test_stage_reports_candidate_phases_and_attributes_data_setup_failures(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        stage = script.split("  stage)", 1)[1].split("    ;;", 1)[0]

        for message in (
            "stage: building isolated candidate images (web, worker, migrate, bootstrap)",
            "stage: waiting for isolated candidate postgres health",
            "stage: applying isolated candidate migrations",
            "stage: bootstrapping isolated candidate data",
            "stage: waiting for isolated candidate web and worker health",
            "stage: checking isolated candidate web health endpoint",
        ):
            self.assertIn(f"log '{message}'", stage)

        self.assertIn(
            'if ! "${compose[@]}" run --rm migrate; then\n'
            "      fail 'candidate migrations failed'",
            stage,
        )
        self.assertIn(
            'if ! "${compose[@]}" --profile bootstrap run --rm --no-deps bootstrap; then\n'
            "      fail 'candidate bootstrap failed'",
            stage,
        )

    def test_stage_normalizes_only_git_tracked_checkout_modes(self):
        script = (ROOT / "scripts/deploy-prod.sh").read_text()
        stage = script.split("  stage)", 1)[1].split("    ;;", 1)[0]
        normalization = script.split("normalize_checkout_modes()", 1)[1].split(
            "protected_health || fail", 1
        )[0]

        self.assertLess(
            stage.index("stage_cleanup_required=1"),
            stage.index("normalize_checkout_modes"),
        )
        self.assertLess(
            stage.index("normalize_checkout_modes"),
            stage.index('"${compose[@]}" build'),
        )
        self.assertIn("git ls-files --stage -z", normalization)
        self.assertIn('chmod 0755 "$deploy_root"', normalization)
        self.assertIn('chmod 0644 -- "$deploy_root/$path"', normalization)
        self.assertIn('if [[ "$mode" == 100755 ]]', normalization)
        self.assertIn('chmod 0755 -- "$deploy_root/$path"', normalization)
        self.assertIn(
            '[[ -f "$deploy_root/$path" && ! -L "$deploy_root/$path" ]]',
            normalization,
        )
        self.assertNotIn("find ", normalization)
        self.assertNotIn("/etc/fai-control-plane-mvp", normalization)


if __name__ == "__main__":
    unittest.main()
