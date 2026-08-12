#!/usr/bin/env python3
import gzip, grp, hashlib, io, json, os, pwd, re, stat, subprocess, sys, tarfile, tempfile
from pathlib import Path

PREFIX = "fai-hermes-runner/"
STATIC = ("scripts/hermes_runner_bundle.py",
          "infra/production/fai-hermes-runner.service", "infra/production/fai-codex-executor.service",
          "infra/production/fai-hermes-planner.service", "infra/production/fai-hermes-planner.tmpfiles",
          "infra/production/fai-hermes-executor.tmpfiles", "packages/runners/runtime/hermes_no_tools_orchestrator.py",
          "packages/runners/runtime/hermes_project_planner_socket.py",
          "packages/domain/src/high-confidence-secret-contract.json",
          "scripts/hermes_planner_health.py", "scripts/activate-hermes-planner.sh",
          "packages/runners/runtime/codex_executor_socket.py", "packages/runners/tsup.config.ts")

CONTROLLER = "fai-hermes-controller"
EXECUTOR = "fai-codex-executor"
TRANSPORT_GROUP = "fai-hermes-transport"
PNPM = "/usr/local/bin/pnpm"
PNPM_VERSION = "11.17.0"
PNPM_STORE = "/opt/fai-control-plane-runner/build/pnpm-store"
RUNNERS_BUILD = "tsup src/index.ts src/hermes-runner-cli.ts src/hermes-executor-cli.ts --format esm --dts --config tsup.config.ts"
PNPM_INSTALL = ("install", "--offline", "--frozen-lockfile", "--frozen-store", "--ignore-scripts",
                "--store-dir", PNPM_STORE)
DIST_FIXED = frozenset(("index.js", "index.d.ts", "hermes-runner-cli.js", "hermes-runner-cli.d.ts",
                        "hermes-executor-cli.js", "hermes-executor-cli.d.ts"))
DIST_CHUNK = re.compile(r"chunk-[A-Z0-9]{8}\.js")
DIST_CHUNK_COUNT = 2
STRICT_CONTROLLER_TREES = (
    "/var/lib/fai-hermes-controller/credentials",
    "/var/lib/fai-hermes-controller/hermes",
    "/var/lib/fai-hermes-controller/state",
)

def digest(data): return hashlib.sha256(data).hexdigest()

def validate_identity_record(user, uid, primary_gid, primary_group, home, shell, groups, lock_state):
    if uid <= 0 or primary_gid <= 0 or primary_group != user or home != f"/var/lib/{user}" or shell != "/usr/sbin/nologin":
        raise ValueError("identity")
    if set(groups) != {user, TRANSPORT_GROUP} or lock_state != "L":
        raise ValueError("identity_groups")

def validate_identity_pair(controller_uid, executor_uid):
    if controller_uid <= 0 or executor_uid <= 0 or controller_uid == executor_uid:
        raise ValueError("identity_alias")

def validate_group_ids(controller_gid, executor_gid, transport_gid):
    if min(controller_gid, executor_gid, transport_gid) <= 0 or len({controller_gid, executor_gid, transport_gid}) != 3:
        raise ValueError("group_alias")

def validate_fs_record(actual_kind, is_link, owner_uid, group_gid, mode, expected_kind,
                       expected_owner_uid, expected_group_gid, expected_mode):
    if is_link or actual_kind != expected_kind or owner_uid != expected_owner_uid or \
       group_gid != expected_group_gid or stat.S_IMODE(mode) != expected_mode:
        raise ValueError("filesystem_binding")

def validate_dist_names(names):
    names = set(names)
    chunks = {name for name in names if DIST_CHUNK.fullmatch(name)}
    if names - DIST_FIXED - chunks or not DIST_FIXED.issubset(names) or \
       len(chunks) != DIST_CHUNK_COUNT or len(names) != len(DIST_FIXED) + DIST_CHUNK_COUNT:
        raise ValueError("dist_allowlist")

def collect_dist(root):
    root = Path(root)
    if not root.is_dir() or root.is_symlink(): raise ValueError("dist_missing")
    entries = list(root.iterdir())
    validate_dist_names(item.name for item in entries)
    result = {}
    for target in entries:
        metadata = target.lstat()
        if target.is_symlink() or not stat.S_ISREG(metadata.st_mode): raise ValueError("dist_type")
        result[target.name] = {"body": target.read_bytes(), "mode": 0o644}
    return result

def compare_dist(first, second):
    if set(first) != set(second): raise ValueError("nondeterministic_dist_set")
    for name in first:
        if first[name] != second[name]: raise ValueError("nondeterministic_dist_hash")

def build_provenance(files):
    dist = sorted(({"name": Path(item["path"]).name, "sha256": item["sha256"]}
                   for item in files if Path(item["path"]).parent == Path("packages/runners/dist")),
                  key=lambda item: item["name"])
    return {"strategy": "isolated-double-build", "packageManager": f"pnpm@{PNPM_VERSION}",
            "installPolicy": "offline-frozen-lockfile-frozen-store-ignore-scripts", "command": RUNNERS_BUILD,
            "repeatBuilds": 2, "dist": dist}

def validate_build_provenance(manifest):
    if manifest.get("build") != build_provenance(manifest.get("files", [])):
        raise ValueError("build_provenance")

def host_check():
    identities = {}
    transport = grp.getgrnam(TRANSPORT_GROUP)
    for user in (CONTROLLER, EXECUTOR):
        record = pwd.getpwnam(user)
        primary = grp.getgrgid(record.pw_gid).gr_name
        groups = [grp.getgrgid(gid).gr_name for gid in os.getgrouplist(user, record.pw_gid)]
        lock_state = subprocess.check_output(["/usr/bin/passwd", "-S", user], text=True).split()[1]
        validate_identity_record(user, record.pw_uid, record.pw_gid, primary, record.pw_dir, record.pw_shell,
                                 groups, lock_state)
        identities[user] = record
    validate_identity_pair(identities[CONTROLLER].pw_uid, identities[EXECUTOR].pw_uid)
    validate_group_ids(identities[CONTROLLER].pw_gid, identities[EXECUTOR].pw_gid, transport.gr_gid)
    controller = identities[CONTROLLER]; executor = identities[EXECUTOR]
    specs = (
      ("/etc/fai-hermes-controller", "directory", 0, controller.pw_gid, 0o750),
      ("/etc/fai-hermes-controller/controller.env", "file", 0, controller.pw_gid, 0o640),
      ("/etc/fai-codex-executor", "directory", 0, executor.pw_gid, 0o750),
      ("/etc/fai-codex-executor/executor.env", "file", 0, executor.pw_gid, 0o640),
      ("/var/lib/fai-hermes-controller", "directory", 0, controller.pw_gid, 0o750),
      ("/var/lib/fai-hermes-controller/credentials", "directory", controller.pw_uid, controller.pw_gid, 0o700),
      ("/var/lib/fai-hermes-controller/credentials/claim-token", "file", controller.pw_uid, controller.pw_gid, 0o600),
      ("/var/lib/fai-hermes-controller/credentials/observation-token", "file", controller.pw_uid, controller.pw_gid, 0o600),
      ("/var/lib/fai-hermes-controller/hermes", "directory", controller.pw_uid, controller.pw_gid, 0o700),
      ("/var/lib/fai-hermes-controller/hermes/config.yaml", "file", controller.pw_uid, controller.pw_gid, 0o600),
      ("/var/lib/fai-hermes-controller/hermes/auth.json", "file", controller.pw_uid, controller.pw_gid, 0o600),
      ("/var/lib/fai-hermes-controller/state", "directory", controller.pw_uid, controller.pw_gid, 0o700),
      ("/var/lib/fai-codex-executor", "directory", 0, executor.pw_gid, 0o750),
      ("/var/lib/fai-codex-executor/codex-home", "directory", executor.pw_uid, executor.pw_gid, 0o700),
      ("/var/lib/fai-codex-executor/codex-home/auth.json", "file", executor.pw_uid, executor.pw_gid, 0o600),
      ("/var/lib/fai-codex-executor/repository", "directory", executor.pw_uid, executor.pw_gid, 0o700),
      ("/var/lib/fai-codex-executor/worktrees", "directory", executor.pw_uid, executor.pw_gid, 0o700),
      ("/var/lib/fai-codex-executor/artifacts", "directory", executor.pw_uid, executor.pw_gid, 0o700),
    )
    for path, kind, owner_uid, group_gid, mode in specs:
        metadata = os.lstat(path)
        actual_kind = "file" if stat.S_ISREG(metadata.st_mode) else "directory" if stat.S_ISDIR(metadata.st_mode) else "other"
        validate_fs_record(actual_kind, stat.S_ISLNK(metadata.st_mode), metadata.st_uid, metadata.st_gid,
                           metadata.st_mode, kind, owner_uid, group_gid, mode)
    # Codex owns its writable HOME and legitimately creates ephemeral helper symlinks there.
    # Its credential boundary remains the exact, non-symlinked auth.json record checked above.
    for root in STRICT_CONTROLLER_TREES:
        owner = controller
        for current, directories, files in os.walk(root, followlinks=False):
            entries = [(item, "directory", 0o700) for item in directories]
            entries += [(item, "file", 0o600) for item in files]
            for name, kind, mode in entries:
                metadata = os.lstat(Path(current) / name)
                actual_kind = "file" if stat.S_ISREG(metadata.st_mode) else "directory" if stat.S_ISDIR(metadata.st_mode) else "other"
                validate_fs_record(actual_kind, stat.S_ISLNK(metadata.st_mode), metadata.st_uid, metadata.st_gid,
                                   metadata.st_mode, kind, owner.pw_uid, owner.pw_gid, mode)

def verify_bundle(bundle, expected_commit, expected_sha, source_root=None):
    raw = Path(bundle).read_bytes()
    if digest(raw) != expected_sha: raise ValueError("archive_hash")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        members = archive.getmembers()
        if any(not item.isfile() or item.name.startswith("/") or ".." in Path(item.name).parts or
               not item.name.startswith(PREFIX) for item in members): raise ValueError("member_type")
        names = [item.name for item in members]
        if len(names) != len(set(names)): raise ValueError("duplicate")
        manifest_name = PREFIX + "RELEASE_MANIFEST.json"
        commit_name = PREFIX + "RELEASE_COMMIT"
        manifest = json.loads(archive.extractfile(manifest_name).read())
        commit = archive.extractfile(commit_name).read().decode().strip()
        if commit != expected_commit or manifest != {"schemaVersion": 2, "commit": expected_commit,
            "build": manifest.get("build"), "files": manifest.get("files")}: raise ValueError("identity")
        expected = {}
        for item in manifest["files"]:
            if set(item) != {"path", "sha256", "mode"} or not isinstance(item["path"], str) or \
               item["path"].startswith("/") or ".." in Path(item["path"]).parts or item["path"] in ("", ".") or \
               not isinstance(item["sha256"], str) or len(item["sha256"]) != 64 or \
               item["mode"] not in (0o644, 0o755):
                raise ValueError("manifest_shape")
            relative = Path(item["path"])
            if item["path"] not in STATIC and not (relative.parent == Path("packages/runners/dist") and relative.name):
                raise ValueError("manifest_scope")
            archive_name = PREFIX + item["path"]
            if archive_name in expected: raise ValueError("manifest_duplicate")
            expected[archive_name] = item
        if not set(STATIC).issubset(item["path"] for item in manifest["files"]):
            raise ValueError("manifest_required")
        validate_dist_names(Path(item["path"]).name for item in manifest["files"]
                            if Path(item["path"]).parent == Path("packages/runners/dist"))
        validate_build_provenance(manifest)
        if set(names) != set(expected) | {manifest_name, commit_name}: raise ValueError("allowlist")
        for name, item in expected.items():
            member = archive.getmember(name); body = archive.extractfile(member).read()
            if digest(body) != item["sha256"] or member.mode != item["mode"] or item["mode"] not in (0o644, 0o755):
                raise ValueError("file_binding")
        if source_root is not None:
            root = Path(source_root).resolve()
            for relative in STATIC:
                source = root / relative
                if source.is_symlink() or not source.is_file() or digest(source.read_bytes()) != expected[PREFIX + relative]["sha256"]:
                    raise ValueError("source_binding")
    return manifest

def verify_install(root, expected_commit, expected_sha):
    requested_root = Path(root)
    if not requested_root.is_dir() or requested_root.is_symlink(): raise ValueError("install_root")
    root = requested_root.resolve()
    root_metadata = root.lstat()
    if root_metadata.st_uid != 0 or root_metadata.st_gid != 0 or stat.S_IMODE(root_metadata.st_mode) != 0o555:
        raise ValueError("install_root_binding")
    manifest = json.loads((root / "RELEASE_MANIFEST.json").read_text())
    if (root / "RELEASE_COMMIT").read_text().strip() != expected_commit or \
       (root / "RELEASE_ARTIFACT_SHA256").read_text().strip() != expected_sha or \
       manifest.get("schemaVersion") != 2 or manifest.get("commit") != expected_commit:
        raise ValueError("install_identity")
    validate_build_provenance(manifest)
    expected = {item["path"]: item for item in manifest.get("files", [])}
    expected_names = set(expected) | {"RELEASE_COMMIT", "RELEASE_MANIFEST.json", "RELEASE_ARTIFACT_SHA256"}
    actual_names = set()
    for path in root.rglob("*"):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
            raise ValueError("install_type")
        if metadata.st_uid != 0 or metadata.st_gid != 0: raise ValueError("install_owner")
        if stat.S_ISDIR(metadata.st_mode) and stat.S_IMODE(metadata.st_mode) != 0o555:
            raise ValueError("install_directory_mode")
        if stat.S_ISREG(metadata.st_mode): actual_names.add(str(path.relative_to(root)))
    if actual_names != expected_names: raise ValueError("install_allowlist")
    for relative, item in expected.items():
        target = root / relative; metadata = target.lstat()
        if digest(target.read_bytes()) != item["sha256"] or stat.S_IMODE(metadata.st_mode) != item["mode"]:
            raise ValueError("install_binding")
    for relative in ("RELEASE_COMMIT", "RELEASE_MANIFEST.json", "RELEASE_ARTIFACT_SHA256"):
        if stat.S_IMODE((root / relative).lstat().st_mode) != 0o644: raise ValueError("install_metadata_mode")

def run_pinned_build(checkout):
    checkout = Path(checkout)
    root_package = json.loads((checkout / "package.json").read_text())
    runners_package = json.loads((checkout / "packages/runners/package.json").read_text())
    if root_package.get("packageManager") != f"pnpm@{PNPM_VERSION}" or \
       runners_package.get("scripts", {}).get("build") != RUNNERS_BUILD or \
       not (checkout / "pnpm-lock.yaml").is_file():
        raise ValueError("build_contract")
    pnpm = Path(PNPM)
    store = Path(PNPM_STORE)
    if not pnpm.is_file() or pnpm.is_symlink() or not os.access(pnpm, os.X_OK) or \
       not store.is_dir() or store.is_symlink():
        raise ValueError("build_toolchain")
    pnpm_metadata = pnpm.lstat(); store_metadata = store.lstat()
    if pnpm_metadata.st_uid != 0 or store_metadata.st_uid != 0 or \
       stat.S_IMODE(pnpm_metadata.st_mode) & 0o022 or stat.S_IMODE(store_metadata.st_mode) & 0o022:
        raise ValueError("build_toolchain_owner")
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(checkout / ".build-home"),
                   "CI": "true", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0"}
    Path(environment["HOME"]).mkdir(mode=0o700)
    if subprocess.check_output([PNPM, "--version"], text=True, env=environment).strip() != PNPM_VERSION:
        raise ValueError("pnpm_version")
    commands = ([PNPM, *PNPM_INSTALL],
                [PNPM, "--filter", "@fai-control-plane/runners", "build"])
    try:
        for command in commands:
            subprocess.run(command, cwd=checkout, env=environment, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=600)
    except (subprocess.SubprocessError, OSError) as error:
        raise ValueError("trusted_build_failed") from error
    if subprocess.check_output(["/usr/bin/git", "-C", str(checkout), "status", "--porcelain",
                                "--untracked-files=no"], text=True).strip():
        raise ValueError("build_changed_source")

def build_checkout(repo, commit, checkout, build_command=run_pinned_build):
    subprocess.run(["/usr/bin/git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(repo), str(checkout)],
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    subprocess.run(["/usr/bin/git", "-C", str(checkout), "checkout", "--quiet", "--detach", commit],
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    if subprocess.check_output(["/usr/bin/git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip() != commit or \
       subprocess.check_output(["/usr/bin/git", "-C", str(checkout), "status", "--porcelain"], text=True).strip():
        raise ValueError("isolated_checkout")
    build_command(checkout)
    return collect_dist(checkout / "packages/runners/dist")

def package(repo, commit, output, build_command=run_pinned_build):
    repo = Path(repo).resolve(); output = Path(output).resolve()
    if os.geteuid() == 0: raise ValueError("root_packaging_forbidden")
    if repo in output.parents: raise ValueError("output_inside_checkout")
    if not re.fullmatch(r"[0-9a-f]{40}", commit): raise ValueError("commit_shape")
    if (repo / "packages/runners/dist").exists(): raise ValueError("caller_dist_forbidden")
    if subprocess.check_output(["/usr/bin/git", "-C", str(repo), "status", "--porcelain"], text=True).strip():
        raise ValueError("dirty_repo")
    if subprocess.check_output(["/usr/bin/git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip() != commit:
        raise ValueError("approved_commit")
    with tempfile.TemporaryDirectory(prefix="fai-hermes-build-") as temporary:
        temporary = Path(temporary)
        first_root = temporary / "build-one"; second_root = temporary / "build-two"
        first_dist = build_checkout(repo, commit, first_root, build_command)
        second_dist = build_checkout(repo, commit, second_root, build_command)
        compare_dist(first_dist, second_dist)
        paths = list(STATIC)
        sources = {relative: first_root / relative for relative in STATIC}
        for name in sorted(first_dist):
            relative = f"packages/runners/dist/{name}"
            paths.append(relative); sources[relative] = first_root / relative
        files = []
        for relative in paths:
            target = sources[relative]; metadata = target.lstat()
            if not stat.S_ISREG(metadata.st_mode) or target.is_symlink(): raise ValueError("source_type")
            body = target.read_bytes() if relative in STATIC else first_dist[Path(relative).name]["body"]
            mode = (0o755 if metadata.st_mode & stat.S_IXUSR else 0o644) if relative in STATIC else 0o644
            files.append({"path": relative, "sha256": digest(body), "mode": mode, "body": body})
    manifest_files = [{key: item[key] for key in ("path", "sha256", "mode")} for item in files]
    manifest = {"schemaVersion": 2, "commit": commit, "files": manifest_files,
                "build": build_provenance(manifest_files)}
    with output.open("wb") as destination, gzip.GzipFile(fileobj=destination, mode="wb", mtime=0, filename="") as compressed, \
         tarfile.open(fileobj=compressed, mode="w") as archive:
        for name, body, mode in [("RELEASE_COMMIT", (commit+"\n").encode(), 0o644),
          ("RELEASE_MANIFEST.json", json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(), 0o644)] + \
          [(item["path"], item["body"], item["mode"]) for item in files]:
            info = tarfile.TarInfo(PREFIX + name); info.size=len(body); info.mode=mode; info.mtime=0; info.uid=info.gid=0
            info.uname=info.gname="root"; archive.addfile(info, io.BytesIO(body))
    print(commit, digest(output.read_bytes()))

if __name__ == "__main__":
    if sys.argv[1:2] == ["package"] and len(sys.argv)==5: package(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1:2] == ["verify"] and len(sys.argv) in (5, 6):
        verify_bundle(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) == 6 else None)
    elif sys.argv[1:2] == ["verify-install"] and len(sys.argv)==5: verify_install(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1:2] == ["host-check"] and len(sys.argv)==2: host_check()
    else: raise SystemExit(2)
