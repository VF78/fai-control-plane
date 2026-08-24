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
        self.assertEqual(readable_block.count('"$deploy_root/'), 8)
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


if __name__ == "__main__":
    unittest.main()
