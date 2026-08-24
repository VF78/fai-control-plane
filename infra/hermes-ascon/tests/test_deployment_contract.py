import hashlib
import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[3]
HERMES = ROOT / "infra/hermes-ascon"


class DeploymentContractTest(unittest.TestCase):
    def test_all_hermes_configs_declare_exact_current_schema(self):
        configs = (
            HERMES / "config.yaml",
            HERMES / "profiles/internal/config.yaml",
            HERMES / "profiles/bitrix-client/config.yaml",
        )
        for config in configs:
            lines = config.read_text().splitlines()
            self.assertEqual(lines[0], "_config_version: 34", config)
            self.assertEqual(lines.count("_config_version: 34"), 1, config)

    def test_bridge_mounts_use_isolated_runtime_copies(self):
        environment_file = HERMES / "production.env.example"
        environment = environment_file.read_text()
        self.assertIn(
            "HERMES_INTERNAL_BRIDGE_TOKEN_FILE="
            "/var/lib/fai-hermes-ascon/runtime-secrets/internal-bridge-token\n",
            environment,
        )
        self.assertIn(
            "HERMES_CLIENT_BRIDGE_TOKEN_FILE="
            "/var/lib/fai-hermes-ascon/runtime-secrets/client-bridge-token\n",
            environment,
        )
        self.assertNotIn("TOKEN_FILE=/etc/fai-hermes-ascon/secrets/", environment)
        self.assertIn(
            "HERMES_RENDERED_CONFIG_FILE="
            "/var/lib/fai-hermes-ascon/runtime-config.yaml\n",
            environment,
        )
        digest = hashlib.sha256(environment_file.read_bytes()).hexdigest()
        runbook = (ROOT / "docs/ops/PRODUCTION_RUNBOOK.md").read_text()
        self.assertIn(digest, runbook)

    def test_stage_prepares_uid_boundary_and_fails_closed(self):
        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()
        readable_block = script.split("readonly -a readable_files=(", 1)[1].split(")", 1)[0]
        self.assertEqual(readable_block.count('"$deploy_root/'), 9)
        self.assertIn('chmod 0644 "${readable_files[@]}"', script)
        self.assertIn('chmod 0755 "${readable_directories[@]}"', script)
        self.assertIn('"$workload_uid:$workload_gid:700"', script)
        self.assertIn('"$workload_uid:$workload_gid:600"', script)
        self.assertIn("run --rm --no-deps --user", script)
        self.assertIn("local deadline=$((SECONDS + 180))", script)
        self.assertLess(
            script.index("wait_for_gateway_health || fail"),
            script.index("https://hermes-ascon.f-ai.studio/health"),
        )
        cleanup = script.split("stage_exit_cleanup()", 1)[1].split("trap stage_exit_cleanup", 1)[0]
        self.assertIn('"${compose[@]}" down', cleanup)
        self.assertIn("remove_runtime_secrets", cleanup)
        self.assertIn("trap - EXIT", cleanup)
        auth_action = script.split("  auth)", 1)[1].split("    ;;", 1)[0]
        self.assertIn("remove_runtime_secrets", auth_action)
        self.assertIn("set +x", script)

        stage_action = script.split("  stage)", 1)[1].split("    ;;", 1)[0]
        self.assertLess(
            script.index('rm -f "$readiness_file"'),
            script.index("production environment does not match approved digest"),
        )
        self.assertLess(stage_action.index("verify_codex_runtime"), stage_action.index("write_readiness"))
        self.assertLess(
            stage_action.index("https://hermes-ascon.f-ai.studio/v1/capabilities"),
            stage_action.index("write_readiness"),
        )
        self.assertIn("remove_readiness", cleanup)
        rollback_action = script.split("  rollback)", 1)[1].split("    ;;", 1)[0]
        self.assertIn("remove_readiness", rollback_action)

    def test_model_config_is_rendered_before_the_container_starts(self):
        config = (HERMES / "config.yaml").read_text()
        compose = (HERMES / "compose.yaml").read_text()
        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()
        self.assertIn("default: __HERMES_MODEL__", config)
        self.assertNotIn("${HERMES_MODEL}", config)
        self.assertIn("free_only: true", config)
        self.assertIn("${HERMES_RENDERED_CONFIG_FILE:?required}:/opt/data/config.yaml:ro", compose)
        self.assertIn("render_runtime_config", script)
        self.assertIn("Hermes model is invalid", script)

    def test_derived_image_and_separate_codex_oauth_are_pinned(self):
        dockerfile = (HERMES / "Dockerfile").read_text()
        compose = (HERMES / "compose.yaml").read_text()
        environment = (HERMES / "production.env.example").read_text()
        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()

        upstream = (
            "nousresearch/hermes-agent:v2026.8.13@sha256:"
            "68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6"
        )
        self.assertIn(f"ARG HERMES_UPSTREAM_IMAGE={upstream}", dockerfile)
        self.assertIn("@openai/codex@0.144.1", dockerfile)
        self.assertIn("USER 10000:10000", dockerfile)
        self.assertIn("ENV CODEX_HOME=/opt/data/codex-home", dockerfile)
        self.assertIn("WORKDIR /opt/data/work/project", dockerfile)
        self.assertIn('user: "10000:10000"', compose)
        self.assertIn("working_dir: /opt/data/work/project", compose)
        self.assertIn("CODEX_HOME: /opt/data/codex-home", compose)
        self.assertIn("HERMES_IMAGE=fai-hermes-ascon:codex-0.144.1", environment)

        codex_service = compose.split("  codex-cli:\n", 1)[1]
        self.assertNotIn("env_file:", codex_service)
        self.assertNotIn("bridge-token", codex_service)
        self.assertNotIn("ports:", codex_service)
        self.assertNotIn('command: ["gateway", "run"]', codex_service)
        self.assertNotIn("/var/lib/fai-hermes-ascon:/opt/data", codex_service)
        self.assertIn(
            "/var/lib/fai-hermes-ascon/codex-home:/opt/data/codex-home",
            codex_service,
        )
        self.assertIn(
            "/var/lib/fai-hermes-ascon/work/project:/opt/data/work/project",
            codex_service,
        )

        codex_auth = script.split("  codex-auth)", 1)[1].split("    ;;", 1)[0]
        self.assertIn("login --device-auth", codex_auth)
        self.assertIn("codex-cli login --device-auth", codex_auth)
        self.assertNotIn("gateway login --device-auth", codex_auth)
        self.assertIn('"$codex_home/auth.json"', codex_auth)
        self.assertNotIn('"$data_root/auth.json"', codex_auth)
        self.assertNotIn("/root/.codex", script)
        self.assertNotIn("$HOME/.codex", script)
        verifier = script.split("verify_codex_runtime() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("codex-cli", verifier)
        self.assertNotIn("gateway", verifier)
        self.assertIn('"${HERMES_APPROVED_IMAGE:-}" == "$upstream_image"', script)
        self.assertIn('== "$derived_image"', script)

    def test_readiness_evidence_matches_web_parser_contract(self):
        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()
        parser = (ROOT / "apps/web/src/mvp/hermes-executor-readiness.ts").read_text()
        writer = script.split("write_readiness() {", 1)[1].split("\n}\n", 1)[0]

        for value in (
            "fai.hermes-codex-readiness.v1",
            "0.144.1",
            "/opt/data/codex-home",
            "/opt/data/work/project",
            "authenticated",
        ):
            self.assertIn(value, script)
            self.assertIn(value, parser)
        self.assertIn("evidence_sha256=$(printf '%s' \"$payload\" | sha256sum", writer)
        self.assertIn("docker image inspect --format '{{.Id}}'", writer)
        self.assertIn('chown root:root "$temporary"', writer)
        self.assertIn('chmod 0644 "$temporary"', writer)
        self.assertIn('mv -f "$temporary" "$readiness_file"', writer)


if __name__ == "__main__":
    unittest.main()
