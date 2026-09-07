import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "agent_update", Path(__file__).parents[3] / "scripts/update-project-agent.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


def container(name, worker=False):
    labels = ({"com.docker.compose.project": "fai-control-plane-mvp",
               "com.docker.compose.service": "worker"} if worker else {
        update.PREFIX + key: value for key, value in {
            "managed": "true", "workspace-id": "workspace", "project-id": "project",
            "runtime-id": "fai-test", "component": "gateway", "spec-sha256": "old"}.items()})
    return {"Id": name + "id", "Name": "/" + name, "Image": "sha256:old",
            "Config": {"Image": "old-tag", "Labels": labels, "Cmd": ["sleep", "infinity"],
                       "User": "0:0", "Env": ["FCP_PROJECT_HERMES_IMAGE=old-tag",
                       "FCP_PROJECT_HERMES_IMAGE_ID=sha256:old", "CODEX_HOME=/opt/data/codex-home"],
                       "Healthcheck": {"Test": ["CMD", "probe"]}},
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "HostConfig": {"Binds": ["/project/data:/opt/data"], "Memory": 1073741824,
                           "CapDrop": ["ALL"], "ReadonlyRootfs": False},
            "NetworkSettings": {"Networks": {"private": {"Aliases": [name, name + "id"],
                                   "IPAddress": "172.0.0.4", "IPAMConfig": None}}}}


class FakeDocker:
    def __init__(self, failure=None):
        self.events = []
        self.values = {"fai-test-gateway": container("fai-test-gateway"),
                       update.WORKER: container(update.WORKER, True)}
        self.failure = failure

    def inspect(self, name):
        return self.values[name]

    def stop(self, name):
        self.events.append(("stop", name))

    def start(self, name):
        self.events.append(("start", name))

    def rename(self, name, target):
        self.events.append(("rename", name))
        self.values[target] = self.values.pop(name)

    def create(self, name, body):
        self.events.append(("create", name))
        self.values[name] = {"Image": body["Image"], "Config": body,
                            "HostConfig": body["HostConfig"],
                            "NetworkSettings": {"Networks": body["NetworkingConfig"]["EndpointsConfig"]}}

    def remove_stopped(self, container_id):
        self.events.append(("remove_stopped", container_id))

    def healthy(self, name):
        self.events.append(("healthy", name))
        if name == self.failure:
            raise RuntimeError("unhealthy")


class Backup:
    name = "upgrade-test"
    path = "/project/upgrade-backups/upgrade-test"

    def __init__(self, docker, fail=False):
        self.docker = docker
        self.fail = fail

    def snapshot(self):
        self.docker.events.append(("backup", "project"))
        if self.fail:
            raise RuntimeError("backup failed")


class ProjectAgentUpdateTest(unittest.TestCase):
    def test_anonymous_writable_volume_aborts_before_stopping_containers(self):
        docker = FakeDocker()
        value = docker.values["fai-test-gateway"]
        value["Config"]["Volumes"] = {"/extra-data": {}}
        value["Mounts"] = [{"Type": "volume", "Name": "anonymous-id",
                            "Source": "/var/lib/docker/volumes/anonymous-id/_data",
                            "Destination": "/extra-data", "RW": True}]
        with self.assertRaisesRegex(RuntimeError, "anonymous volume"):
            self.execute(docker)
        self.assertEqual(docker.events, [])
        value["HostConfig"]["Mounts"] = [{"Type": "volume", "Source": "anonymous-id",
                                          "Target": "/extra-data"}]
        self.assertEqual(update.replacement_spec(value, "sha256:new")["HostConfig"]["Mounts"],
                         value["HostConfig"]["Mounts"])

    def test_accepts_only_exact_label_derived_root(self):
        value = container("fai-test-gateway")
        workspace = "00000000-0000-4000-8000-000000000001"
        project = "00000000-0000-4000-8000-000000000002"
        value["Config"]["Labels"][update.PREFIX + "workspace-id"] = workspace
        value["Config"]["Labels"][update.PREFIX + "project-id"] = project
        root = update.RUNTIME_ROOT / workspace / project
        value["Mounts"] = [{"Destination": "/opt/data", "Type": "bind", "Source": str(root / "data")}]
        with patch.object(Path, "is_dir", return_value=True), patch.object(Path, "is_symlink", return_value=False), \
                patch.object(Path, "resolve", lambda path: path):
            self.assertEqual(update.owned_gateway(value, "fai-test-gateway"), root)
            value["Mounts"][0]["Source"] = str(root.parent / "other-project" / "data")
            with self.assertRaisesRegex(RuntimeError, "root"):
                update.owned_gateway(value, "fai-test-gateway")

    def test_idle_check_includes_native_api_and_background_work(self):
        status = {"gateway_busy": False, "gateway_drainable": True, "active_agents": 0,
                  "readiness": {"checks": {"background_queues": {
                      "active_api_runs": 0, "process_completions": 0, "active_delegations": 0}}}}
        update.require_idle(status)
        status["readiness"]["checks"]["background_queues"]["active_api_runs"] = 1
        with self.assertRaisesRegex(RuntimeError, "busy"):
            update.require_idle(status)
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            update.require_idle({})

    def execute(self, docker, backup=None, probe=lambda _: None):
        return update.perform_update(docker, "fai-test-gateway",
                                     copy.deepcopy(docker.values["fai-test-gateway"]),
                                     copy.deepcopy(docker.values[update.WORKER]),
                                     "sha256:new", "new-tag", backup or Backup(docker), probe)

    def test_preserves_configuration_security_and_declared_networks(self):
        original = container("fai-test-gateway")
        body = update.replacement_spec(original, "sha256:new")
        self.assertEqual(body["Env"], original["Config"]["Env"])
        self.assertEqual(body["HostConfig"], original["HostConfig"])
        self.assertEqual(body["Healthcheck"], original["Config"]["Healthcheck"])
        self.assertEqual(body["NetworkingConfig"]["EndpointsConfig"],
                         {"private": {"Aliases": ["fai-test-gateway"]}})
        self.assertNotEqual(body["Labels"][update.PREFIX + "spec-sha256"], "old")
        self.assertEqual(original["Config"]["Labels"][update.PREFIX + "spec-sha256"], "old")

    def test_quiesces_controller_and_bot_before_backup_and_replacement(self):
        docker = FakeDocker()
        self.execute(docker)
        self.assertEqual(docker.events[:3], [("stop", update.WORKER),
                                            ("stop", "fai-test-gateway"), ("backup", "project")])
        self.assertLess(docker.events.index(("healthy", "fai-test-gateway")),
                        docker.events.index(("start", update.WORKER)))
        self.assertNotIn(("start", "fai-test-gateway-upgrade-test"), docker.events)

    def test_worker_refresh_changes_only_existing_image_environment(self):
        docker = FakeDocker()
        self.execute(docker)
        worker = docker.values[update.WORKER]
        self.assertEqual(worker["Image"], "sha256:old")
        self.assertEqual(worker["Config"]["Env"], ["FCP_PROJECT_HERMES_IMAGE=new-tag",
                         "FCP_PROJECT_HERMES_IMAGE_ID=sha256:new", "CODEX_HOME=/opt/data/codex-home"])
        self.assertLess(docker.events.index(("healthy", update.WORKER)),
                        docker.events.index(("remove_stopped", update.WORKER + "id")))

    def test_does_not_replace_worker_when_image_environment_already_matches(self):
        docker = FakeDocker()
        docker.values[update.WORKER]["Config"]["Env"] = ["FCP_PROJECT_HERMES_IMAGE=new-tag",
            "FCP_PROJECT_HERMES_IMAGE_ID=sha256:new"]
        self.execute(docker)
        self.assertNotIn(("create", update.WORKER), docker.events)
        self.assertIn(("start", update.WORKER), docker.events)

    def test_create_failure_restores_original_gateway_name_before_restart(self):
        docker = FakeDocker()
        original_create = docker.create
        def create(name, body):
            if name == "fai-test-gateway":
                raise RuntimeError("create failed")
            original_create(name, body)
        docker.create = create
        original_rename = docker.rename
        def rename(name, target):
            if name == "fai-test-gatewayid":
                docker.events.append(("rename", name))
                docker.values[target] = docker.values.pop("fai-test-gateway-upgrade-test")
            else:
                original_rename(name, target)
        docker.rename = rename
        with self.assertRaises(RuntimeError):
            self.execute(docker)
        self.assertLess(docker.events.index(("rename", "fai-test-gatewayid")),
                        docker.events.index(("start", "fai-test-gatewayid")))

    def test_uncertain_start_failure_does_not_resume_original_bot(self):
        docker = FakeDocker()
        original_start = docker.start
        def start(name):
            original_start(name)
            if name == "fai-test-gateway":
                raise RuntimeError("start response lost")
        docker.start = start
        with self.assertRaises(RuntimeError):
            self.execute(docker)
        self.assertNotIn(("start", "fai-test-gatewayid"), docker.events)
        self.assertIn(("stop", "fai-test-gateway"), docker.events)

    def test_failed_gateway_health_stops_new_bot_and_never_starts_old(self):
        docker = FakeDocker("fai-test-gateway")
        with self.assertRaisesRegex(RuntimeError, "backup:"):
            self.execute(docker)
        self.assertEqual(docker.events[-2:], [("stop", "fai-test-gateway"), ("stop", update.WORKER)])
        self.assertNotIn(("start", "fai-test-gateway-upgrade-test"), docker.events)
        self.assertNotIn(("start", update.WORKER), docker.events)

    def test_failed_worker_health_stops_both_replacements(self):
        docker = FakeDocker(update.WORKER)
        with self.assertRaises(RuntimeError):
            self.execute(docker)
        self.assertEqual(docker.events[-2:], [("stop", "fai-test-gateway"), ("stop", update.WORKER)])
        self.assertFalse(any(event[0] == "remove_stopped" for event in docker.events))

    def test_backup_failure_resumes_unchanged_originals_by_id(self):
        docker = FakeDocker()
        with self.assertRaises(RuntimeError):
            self.execute(docker, Backup(docker, True))
        self.assertEqual(docker.events[-2:], [("start", "fai-test-gatewayid"),
                                            ("start", update.WORKER + "id")])
        self.assertFalse(any(event[0] == "create" for event in docker.events))

    def test_oauth_probe_failure_stops_before_worker_replacement(self):
        docker = FakeDocker()
        def probe(_):
            raise RuntimeError("auth unavailable")
        with self.assertRaises(RuntimeError):
            self.execute(docker, probe=probe)
        self.assertNotIn(("create", update.WORKER), docker.events)

    def test_denies_unowned_gateway_before_mount_access(self):
        value = container("fai-test-gateway")
        value["Config"]["Labels"][update.PREFIX + "managed"] = "false"
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            update.owned_gateway(value, "fai-test-gateway")

    def test_denies_other_compose_worker(self):
        value = container(update.WORKER, True)
        value["Config"]["Labels"]["com.docker.compose.project"] = "protected-neighbour"
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            update.owned_worker(value)


if __name__ == "__main__":
    unittest.main()
