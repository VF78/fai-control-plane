#!/usr/bin/env python3
"""Replace one owned Hermes gateway without provisioning or a panel release."""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time


WORKER = "fai-control-plane-mvp-worker-1"
PREFIX = "fai.control-plane."
RUNTIME_ROOT = Path("/var/lib/fai-project-runtimes")


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


class Docker:
    def request(self, method, path, body=None):
        connection = DockerConnection("localhost", timeout=90)
        try:
            connection.request(method, "/v1.45" + path,
                               None if body is None else json.dumps(body),
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            payload = response.read()
            if response.status not in (200, 201, 204, 304):
                raise RuntimeError(f"Docker {method} failed ({response.status})")
            return json.loads(payload) if payload else None
        finally:
            connection.close()

    def inspect(self, name):
        return self.request("GET", f"/containers/{name}/json")

    def stop(self, name):
        self.request("POST", f"/containers/{name}/stop?t=30")

    def start(self, name):
        self.request("POST", f"/containers/{name}/start")

    def rename(self, name, target):
        self.request("POST", f"/containers/{name}/rename?name={target}")

    def create(self, name, spec):
        self.request("POST", f"/containers/create?name={name}", spec)

    def remove_stopped(self, container_id):
        self.request("DELETE", f"/containers/{container_id}")

    def healthy(self, name):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            state = self.inspect(name)["State"]
            if state.get("Running") and state.get("Health", {}).get("Status") == "healthy":
                return
            if not state.get("Running") or state.get("Health", {}).get("Status") == "unhealthy":
                break
            time.sleep(3)
        raise RuntimeError(f"{name} did not become healthy")


def run(arguments, **kwargs):
    # Child output can contain credential/login details. Never include it in errors.
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{arguments[0]} operation failed (exit {result.returncode})")
    return result.stdout.decode().strip()


def native_status(name):
    code = ("import urllib.request; "
            "print(urllib.request.urlopen('http://127.0.0.1:9119/api/status', "
            "timeout=10).read().decode())")
    return json.loads(run(["docker", "exec", "--user", "10000:10000", name,
                           "python", "-c", code]))


def require_idle(status):
    if (status.get("gateway_running") is not True
            or status.get("gateway_state") != "running"
            or status.get("gateway_busy") is not False
            or status.get("active_agents") != 0
            or status.get("gateway_drainable") is not True):
        raise RuntimeError("agent is busy or native idle state is unknown; retry after its work finishes")


def connected_platforms(status):
    platforms = status.get("gateway_platforms", {})
    return {key for key, value in platforms.items() if value.get("state") == "connected"}


def owned_gateway(value, name):
    labels = value.get("Config", {}).get("Labels", {})
    runtime = labels.get(PREFIX + "runtime-id", "")
    workspace = labels.get(PREFIX + "workspace-id", "")
    project = labels.get(PREFIX + "project-id", "")
    uuid = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
    expected = {"managed": "true", "workspace-id": workspace,
                "project-id": project, "runtime-id": runtime, "component": "gateway"}
    if (not re.fullmatch(uuid, workspace) or not re.fullmatch(uuid, project)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", runtime)
            or name != runtime + "-gateway" or value.get("Name") != "/" + name
            or any(labels.get(PREFIX + key) != item for key, item in expected.items())):
        raise RuntimeError("gateway ownership mismatch")
    mounts = value.get("Mounts", [])
    data = [m for m in mounts if m.get("Destination") == "/opt/data"]
    if len(data) != 1 or data[0].get("Type") != "bind":
        raise RuntimeError("project data bind is unavailable")
    path = Path(data[0]["Source"])
    root = path.parent
    if (path.name != "data" or root != RUNTIME_ROOT / workspace / project
            or root.resolve() != root or not path.is_dir()
            or path.is_symlink()):
        raise RuntimeError("project runtime root is invalid")
    if not value.get("State", {}).get("Running"):
        raise RuntimeError("gateway must be running before upgrade")
    return root


def owned_worker(value):
    labels = value.get("Config", {}).get("Labels", {})
    if (value.get("Name") != "/" + WORKER
            or labels.get("com.docker.compose.project") != "fai-control-plane-mvp"
            or labels.get("com.docker.compose.service") != "worker"
            or not value.get("State", {}).get("Running")):
        raise RuntimeError("worker ownership/state mismatch")


def replacement_spec(value, image, environment=None):
    # Config.Volumes alone would allocate fresh anonymous storage on recreation.
    host = value["HostConfig"]
    for mount in value.get("Mounts", []):
        if mount.get("Type") not in ("bind", "volume"):
            continue
        source = mount.get("Name") if mount["Type"] == "volume" else mount.get("Source")
        destination = mount.get("Destination")
        bindings = [binding.split(":") for binding in host.get("Binds") or []]
        explicit_bind = any(len(parts) >= 2 and parts[:2] == [source, destination]
                            for parts in bindings)
        explicit_mount = any(item.get("Type") == mount["Type"]
                             and item.get("Source") == source and item.get("Target") == destination
                             for item in host.get("Mounts") or [])
        if not source or not (explicit_bind or explicit_mount):
            raise RuntimeError("persistent mount is not explicitly preserved; anonymous volume upgrade refused")
    # Config is Docker's create-config schema. HostConfig retains security and limits.
    spec = json.loads(json.dumps(value["Config"]))
    spec["Image"] = image
    if environment:
        names = {entry.split("=", 1)[0] for entry in spec.get("Env", [])}
        if not environment.keys() <= names:
            raise RuntimeError("worker image configuration is unavailable")
        spec["Env"] = [f"{entry.split('=', 1)[0]}={environment[entry.split('=', 1)[0]]}"
                       if entry.split("=", 1)[0] in environment else entry
                       for entry in spec["Env"]]
    spec["HostConfig"] = json.loads(json.dumps(value["HostConfig"]))
    endpoints = {}
    for network, config in value["NetworkSettings"]["Networks"].items():
        # Retain declared aliases/static IP configuration, never stale allocated addresses.
        endpoints[network] = {key: config[key] for key in ("Aliases", "IPAMConfig", "DriverOpts")
                              if config.get(key) is not None}
        if "Aliases" in endpoints[network]:
            endpoints[network]["Aliases"] = [alias for alias in endpoints[network]["Aliases"]
                                             if alias not in (value["Id"], value["Id"][:12])]
    spec["NetworkingConfig"] = {"EndpointsConfig": endpoints}
    labels = spec.setdefault("Labels", {})
    labels.pop(PREFIX + "spec-sha256", None)
    if labels.get(PREFIX + "managed") == "true":
        labels[PREFIX + "spec-sha256"] = hashlib.sha256(
            json.dumps(spec, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return spec


def replace(docker, old, backup_name, spec):
    docker.rename(old, backup_name)
    docker.create(old, spec)
    docker.start(old)
    docker.healthy(old)


def verify_replacement(docker, name, image, original):
    actual = docker.inspect(name)
    if (actual.get("Image") != image
            or actual.get("HostConfig", {}).get("Binds") != original["HostConfig"].get("Binds")
            or set(actual["NetworkSettings"]["Networks"]) != set(original["NetworkSettings"]["Networks"])):
        raise RuntimeError("replacement image, mounts or networks do not match")


def perform_update(docker, gateway, gateway_value, worker_value, image, tag, backup, probe, idle=lambda _: None):
    """Fail closed after native startup: keep backups stopped, never duplicate bots."""
    suffix = backup.name
    old_gateway = gateway + "-" + suffix
    old_worker = WORKER + "-" + suffix
    gateway_spec = replacement_spec(gateway_value, image)
    worker_spec = replacement_spec(worker_value, worker_value["Image"], {
        "FCP_PROJECT_HERMES_IMAGE": tag, "FCP_PROJECT_HERMES_IMAGE_ID": image})
    refresh_worker = worker_spec["Env"] != worker_value["Config"]["Env"]
    docker.stop(WORKER)  # Recovery cannot restart the old gateway during the switch.
    gateway_stopped = False
    gateway_renamed = False
    replacement_started = False
    try:
        idle(gateway)  # Recheck after stopping controller submissions.
        docker.stop(gateway)
        gateway_stopped = True
        backup.snapshot()
        docker.rename(gateway, old_gateway)
        gateway_renamed = True
        docker.create(gateway, gateway_spec)
        # A start request can succeed even if the response is lost.
        replacement_started = True
        docker.start(gateway)
        docker.healthy(gateway)
        verify_replacement(docker, gateway, image, gateway_value)
        probe(gateway)
        if refresh_worker:
            replace(docker, WORKER, old_worker, worker_spec)
            verify_replacement(docker, WORKER, worker_value["Image"], worker_value)
        else:
            docker.start(WORKER)
            docker.healthy(WORKER)
    except Exception:
        if replacement_started:
            # Its startup may have changed native state. Preserve both containers/data.
            docker.stop(gateway)
            try:
                docker.stop(WORKER)
            except Exception:
                pass  # It can still have its rollback name if creation failed.
        elif gateway_stopped:
            # Before native startup no runtime data migration occurred.
            # Use immutable old ID even if its name was already moved.
            if gateway_renamed:
                docker.rename(gateway_value["Id"], gateway)
            docker.start(gateway_value["Id"])
            docker.start(worker_value["Id"])
        else:
            docker.start(worker_value["Id"])
        raise RuntimeError(f"update failed; backup: {backup.path}. "
                           "If native startup occurred, the gateway and worker remain stopped; "
                           "follow the agent-update recovery section of PRODUCTION_RUNBOOK.md "
                           "before restarting the controller.") from None
    if refresh_worker:
        # Keep worker.json for recovery; duplicate Compose ownership labels confuse releases.
        try:
            docker.remove_stopped(worker_value["Id"])
        except Exception:
            warning = f"cleanup pending: remove stopped old worker {worker_value['Id']} without volumes"
            print(f"Warning: agent and worker healthy; {warning}", file=sys.stderr)
            return old_gateway, warning
    return old_gateway, "old worker removed" if refresh_worker else "worker unchanged"


class Backup:
    def __init__(self, root, gateway, worker):
        self.name = "upgrade-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        self.path = root / "upgrade-backups" / self.name
        self.root = root
        self.gateway = gateway
        self.worker = worker

    def snapshot(self):
        if self.path.parent.is_symlink():
            raise RuntimeError("backup directory must not be a symlink")
        self.path.mkdir(mode=0o700, parents=True, exist_ok=False)
        for name, value in (("gateway", self.gateway), ("worker", self.worker)):
            with (self.path / (name + ".json")).open("x") as output:
                json.dump(value, output)
        run(["tar", "--exclude=./upgrade-backups", "-czf", str(self.path / "project.tar.gz"),
             "-C", str(self.root), "."])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--use-image-id", help="Use this already built, exact shared image ID")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root on the production host")
    os.umask(0o077)
    # Serialize updates across projects because all use the same controller/image.
    lock = open("/run/fai-project-agent-update.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not re.fullmatch(r"[a-z0-9-]{1,56}", args.gateway):
        parser.error("invalid gateway name")
    repo = Path(__file__).resolve().parent.parent
    compose = (repo / "infra/production/compose.yaml").read_text()
    tag = re.search(r"FCP_PROJECT_HERMES_IMAGE: (fai-hermes-project:[A-Za-z0-9._-]+)", compose).group(1)
    for script, variable in (("deploy-prod.sh", "project_runtime_image"),
                             ("production-compose-readonly.sh", "runtime_image")):
        if f"readonly {variable}={tag}\n" not in (repo / "scripts" / script).read_text():
            raise RuntimeError("normal deployment and agent update image pins disagree")
    pins = ["infra/hermes-project/Dockerfile", "infra/production/compose.yaml",
            "scripts/deploy-prod.sh", "scripts/production-compose-readonly.sh"]
    if run(["git", "-C", str(repo), "status", "--porcelain", "--", *pins]):
        raise RuntimeError("runtime image pins must come from a clean reviewed commit")
    codex_version = re.search(r"@openai/codex@([0-9.]+)",
                             (repo / pins[0]).read_text()).group(1)
    docker = Docker()
    gateway = docker.inspect(args.gateway)
    worker = docker.inspect(WORKER)
    root = owned_gateway(gateway, args.gateway)
    owned_worker(worker)
    baseline = native_status(args.gateway)
    require_idle(baseline)
    required_platforms = connected_platforms(baseline)
    if "api_server" not in required_platforms:
        raise RuntimeError("native API platform is not connected")
    if not args.use_image_id:
        print("Building the shared pinned agent image", flush=True)
        run(["docker", "build", "--pull", "--tag", tag, "--file",
             str(repo / "infra/hermes-project/Dockerfile"), str(repo)])
    image = run(["docker", "image", "inspect", "--format", "{{.Id}}", tag])
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image) or (args.use_image_id and image != args.use_image_id):
        raise RuntimeError("shared image does not match the supplied immutable ID")
    backup = Backup(root, gateway, worker)
    def probe(name):
        cli = ["docker", "exec", "--user", "10000:10000", "--env",
               "CODEX_HOME=/opt/data/codex-home", name]
        version = run([*cli, "codex", "--version"])
        if version != "codex-cli " + codex_version:
            raise RuntimeError("running Codex version differs from the reviewed pin")
        run([*cli, "codex", "login", "status"])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status = native_status(name)
            if (status.get("gateway_running") is True
                    and status.get("gateway_state") == "running"
                    and required_platforms <= connected_platforms(status)):
                return
            time.sleep(3)
        raise RuntimeError("native API/messenger connections did not recover")
    # Building can take minutes; abort if another operator replaced either target.
    if (docker.inspect(args.gateway)["Id"] != gateway["Id"]
            or docker.inspect(WORKER)["Id"] != worker["Id"]):
        raise RuntimeError("runtime changed during image build; rerun against current state")
    if gateway["Image"] == image:
        values = dict(entry.split("=", 1) for entry in worker["Config"]["Env"])
        if (values.get("FCP_PROJECT_HERMES_IMAGE") != tag
                or values.get("FCP_PROJECT_HERMES_IMAGE_ID") != image):
            raise RuntimeError("gateway already updated but worker image pins differ; reconcile worker configuration before retrying")
        probe(args.gateway)
        print("Agent and shared worker image pins are already current; no changes.")
        return
    print("Stopping the worker and selected gateway; preserving project state", flush=True)
    old_gateway, old_worker = perform_update(docker, args.gateway, gateway, worker, image, tag, backup, probe,
                                            lambda name: require_idle(native_status(name)))
    print(f"Agent healthy; future installs use {image}. Backup: {backup.path}. "
          f"Stopped rollback gateway: {old_gateway}; {old_worker}.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
