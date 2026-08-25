import hashlib
import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[3]
HERMES = ROOT / "infra/hermes-ascon"


class DeploymentContractTest(unittest.TestCase):
    def test_project_logs_are_bounded_and_stage_prunes_old_images(self):
        compose = (HERMES / "compose.yaml").read_text()
        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()

        self.assertIn("x-logging: &bounded-logging", compose)
        self.assertIn('max-size: "10m"', compose)
        self.assertIn('max-file: "3"', compose)
        self.assertEqual(compose.count("logging: *bounded-logging"), 4)
        stage_action = script.split("  stage)", 1)[1].split("    ;;", 1)[0]
        self.assertIn("prune_superseded_project_images", stage_action)
        self.assertIn(
            "label=com.docker.compose.project=fai-hermes-ascon",
            script,
        )
        self.assertIn("docker builder prune -af", script)

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
        self.assertEqual(readable_block.count('"$deploy_root/'), 10)
        self.assertIn('chmod 0644 "${readable_files[@]}"', script)
        self.assertIn('chmod 0755 "${readable_directories[@]}"', script)
        self.assertIn('"$workload_uid:$workload_gid:755"', script)
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
        self.assertIn(
            "--entrypoint /opt/hermes/bin/hermes gateway auth status openai-codex",
            stage_action,
        )
        self.assertLess(stage_action.index('"${compose[@]}" down'), stage_action.index('rm -f "$gateway_pid_file"'))
        self.assertLess(stage_action.index('rm -f "$gateway_pid_file"'), stage_action.index('"${compose[@]}" up -d gateway'))
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
        gateway = compose.split("  gateway:", 1)[1].split("\n  codex-cli:", 1)[0]
        self.assertIn('entrypoint: ["/opt/hermes/bin/hermes"]', gateway)
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
            "/var/lib/fai-codex-ascon/home:/opt/data/codex-home",
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

    def test_public_run_status_route_is_get_only_and_bounded(self):
        nginx = (HERMES / "nginx/hermes-ascon.f-ai.studio.conf").read_text()
        route = nginx.split(
            'location ~ "^/v1/runs/run_[A-Za-z0-9_-]{1,250}$" {', 1
        )[1].split("\n    }", 1)[0]
        self.assertIn("limit_except GET { deny all; }", route)
        self.assertIn("proxy_pass http://fai_hermes_ascon$request_uri;", route)
        self.assertNotIn("/events", nginx)
        self.assertNotIn("/stop", nginx)

        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()
        self.assertIn('readonly nginx_file=/etc/nginx/sites-available/hermes-ascon.f-ai.studio.conf', script)
        self.assertIn('readlink -f "$nginx_enabled"', script)
        self.assertIn("installed Hermes Nginx config permissions are invalid", script)
        self.assertIn('install_nginx_config', script)
        self.assertIn('nginx -t && systemctl reload nginx', script)
        self.assertIn('automatic Hermes Nginx restore failed', script)
        self.assertIn('run_fai_deploy_probe', script)
        self.assertIn('"run_not_found"', script)
        self.assertIn('for attempt in {1..10}; do', script)
        self.assertIn("run_status_ready=1", script)
        self.assertIn("sleep 1", script)
        stage = script.split("  stage)", 1)[1].split("    ;;", 1)[0]
        self.assertLess(stage.index("install_nginx_config"), stage.index("write_readiness"))
        self.assertLess(stage.index("write_readiness"), stage.index("commit_nginx_config"))

    def test_repository_broker_is_an_inactive_secret_isolated_sidecar(self):
        compose = (HERMES / "compose.yaml").read_text()
        broker = compose.split("  repository-broker:\n", 1)[1].split("\n  executor-broker:", 1)[0]
        gateway = compose.split("  gateway:\n", 1)[1].split("\n  repository-broker:", 1)[0]
        codex = compose.split("  codex-cli:\n", 1)[1]
        self.assertIn("profiles: [repository-work]", broker)
        self.assertIn("FCP_REPOSITORY_AUTHORIZATION_URL:?required", broker)
        self.assertIn("FCP_REPOSITORY_BROKER_RELEASE:-disabled", broker)
        self.assertIn("FCP_GITHUB_APP_ID:-0", broker)
        self.assertIn("FCP_GITHUB_APP_INSTALLATION_ID:-0", broker)
        self.assertIn("FCP_GITHUB_APP_PRIVATE_KEY_FILE:-/dev/null", broker)
        self.assertNotIn("FCP_GITHUB_APP_ID:?required", broker)
        self.assertNotIn("disabled.invalid", broker)
        dockerfile = (ROOT / "infra/repository-broker/Dockerfile").read_text()
        self.assertIn("repository-broker-cli.js", dockerfile)
        self.assertIn("node:24-bookworm-slim@sha256:", dockerfile)
        self.assertIn("github-app-private-key.pem:ro", broker)
        self.assertIn("broker.sock", broker)
        self.assertIn("cap_drop: [ALL]", broker)
        self.assertIn("/run/fai-repository-broker", gateway)
        self.assertIn(
            "/var/lib/fai-repository-broker-ascon:/var/lib/fai-repository-broker",
            broker,
        )
        self.assertNotIn("fai-hermes-ascon/repository-broker-state", broker)
        self.assertNotIn("/var/lib/fai-repository-broker-ascon", gateway)
        self.assertNotIn("github-app-private-key", gateway)
        self.assertNotIn("github-app-private-key", codex)
        self.assertNotIn("FCP_GITHUB_APP", codex)
        self.assertNotIn("/var/lib/fai-repository-broker-ascon", codex)

        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()
        self.assertIn("https://app.f-ai.studio/api/hermes/repository-authorizations", script)
        self.assertIn("probe_repository_authorization", script)
        activate = script.split("activate_trusted_execution() {", 1)[1].split("\n}", 1)[0]
        self.assertIn("probe_repository_authorization", activate)

    def test_executor_broker_is_the_only_cli_credential_and_signing_boundary(self):
        compose = (HERMES / "compose.yaml").read_text()
        gateway = compose.split("  gateway:\n", 1)[1].split("\n  repository-broker:", 1)[0]
        executor = compose.split("  executor-broker:\n", 1)[1].split("\n  codex-cli:", 1)[0]
        plugin = (HERMES / "extensions/fai-control-plane/__init__.py").read_text()
        script = (ROOT / "scripts/deploy-hermes-ascon.sh").read_text()
        broker_code = (HERMES / "executor-broker.mjs").read_text()
        self.assertIn("profiles: [repository-work]", executor)
        self.assertIn('/opt/fai/executor-broker.mjs', executor)
        self.assertIn('/var/lib/fai-codex-ascon/home:/opt/data/codex-home', executor)
        self.assertIn('executor-attestation-private-key.pem:ro', executor)
        self.assertNotIn('executor-attestation-private-key', gateway)
        self.assertIn('codex-home-mask:/opt/data/codex-home:ro', gateway)
        gateway_probe = script.split("probe_runtime() {", 1)[1].split("\n}\n", 1)[0]
        self.assertNotIn('/opt/data/codex-home/.uid-10000-write-probe', gateway_probe)
        self.assertIn('fai_executor_run', plugin)
        self.assertIn('session_id = str(kwargs.get("session_id")', plugin)
        self.assertIn('activate_trusted_execution', script)
        self.assertIn('remove_trusted_readiness', script)
        activate = script.split("  activate)", 1)[1].split("    ;;", 1)[0]
        self.assertIn('activate_trusted_execution', activate)
        self.assertIn("const codex = '/usr/local/bin/codex'", broker_code)
        self.assertIn("'--model', model", broker_code)
        self.assertIn('model_reasoning_effort=', broker_code)
        self.assertIn("sign(null, Buffer.from(canonical), privateKey)", broker_code)
        self.assertNotIn('payload.command', broker_code)
        self.assertNotIn('payload.args', broker_code)


if __name__ == "__main__":
    unittest.main()
