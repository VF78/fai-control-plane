import gzip
import hashlib
import importlib.util
import io
import json
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("hermes_runner_bundle.py")
SPEC = importlib.util.spec_from_file_location("bundle", MODULE_PATH)
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)
DIST_CHUNKS = {"chunk-ABCDEFGH.js", "chunk-IJKLMNOP.js"}


def archive_bytes(file_hash=None, extra=None, symlink=False):
    files = []
    bodies = {}
    for path in bundle.STATIC:
        body = (path + "\n").encode()
        bodies[path] = body
        files.append({"path": path, "sha256": hashlib.sha256(body).hexdigest(), "mode": 0o644})
    for name in sorted(bundle.DIST_FIXED | DIST_CHUNKS):
        path = "packages/runners/dist/" + name
        body = (path + "\n").encode(); bodies[path] = body
        files.append({"path": path, "sha256": hashlib.sha256(body).hexdigest(), "mode": 0o644})
    if file_hash is not None:
        files[0]["sha256"] = file_hash
    manifest = {"schemaVersion": 2, "commit": "a" * 40, "files": files,
                "build": bundle.build_provenance(files)}
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            entries = [("RELEASE_COMMIT", ("a" * 40 + "\n").encode()),
                       ("RELEASE_MANIFEST.json", json.dumps(manifest).encode())]
            entries.extend((path, bodies[path]) for path in bodies)
            if extra: entries.append((extra, b"extra"))
            for name, body in entries:
                info = tarfile.TarInfo(bundle.PREFIX + name)
                if symlink and name == bundle.STATIC[0]:
                    info.type = tarfile.SYMTYPE; info.linkname = "/etc/passwd"; info.size = 0
                    archive.addfile(info)
                else:
                    info.size = len(body); info.mode = 0o644
                    archive.addfile(info, io.BytesIO(body))
    return output.getvalue()


class BundleTest(unittest.TestCase):
    def verify(self, raw):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "bundle.tar.gz"
            path.write_bytes(raw)
            return bundle.verify_bundle(path, "a" * 40, hashlib.sha256(raw).hexdigest())

    def test_valid_bundle(self):
        self.verify(archive_bytes())

    def test_source_binding_rejects_non_commit_file(self):
        raw = archive_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"; root.mkdir()
            for relative in bundle.STATIC:
                target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((relative + "\n").encode())
            path = Path(temporary) / "bundle.tar.gz"; path.write_bytes(raw)
            bundle.verify_bundle(path, "a" * 40, hashlib.sha256(raw).hexdigest(), root)
            (root / bundle.STATIC[0]).write_text("drift")
            with self.assertRaisesRegex(ValueError, "source_binding"):
                bundle.verify_bundle(path, "a" * 40, hashlib.sha256(raw).hexdigest(), root)

    def test_rejects_extra_member(self):
        with self.assertRaisesRegex(ValueError, "allowlist"):
            self.verify(archive_bytes(extra="packages/runners/dist/extra.js"))

    def test_rejects_symlink_member(self):
        with self.assertRaisesRegex(ValueError, "member_type"):
            self.verify(archive_bytes(symlink=True))

    def test_rejects_hash_mismatch(self):
        with self.assertRaisesRegex(ValueError, "file_binding"):
            self.verify(archive_bytes(file_hash="0" * 64))

    def test_identity_rejects_root_alias_and_unsafe_group(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            bundle.validate_identity_record(bundle.CONTROLLER, 0, 1001, bundle.CONTROLLER,
                                            "/var/lib/" + bundle.CONTROLLER, "/usr/sbin/nologin",
                                            [bundle.CONTROLLER, bundle.TRANSPORT_GROUP], "L")
        with self.assertRaisesRegex(ValueError, "identity_alias"):
            bundle.validate_identity_pair(1001, 1001)
        with self.assertRaisesRegex(ValueError, "identity_groups"):
            bundle.validate_identity_record(bundle.CONTROLLER, 1001, 1001, bundle.CONTROLLER,
                                            "/var/lib/" + bundle.CONTROLLER, "/usr/sbin/nologin",
                                            [bundle.CONTROLLER, bundle.TRANSPORT_GROUP, "docker"], "L")

    def test_identity_rejects_root_and_aliased_group_ids(self):
        with self.assertRaisesRegex(ValueError, "group_alias"):
            bundle.validate_group_ids(0, 1002, 1003)
        with self.assertRaisesRegex(ValueError, "group_alias"):
            bundle.validate_group_ids(1001, 1001, 1003)
        with self.assertRaisesRegex(ValueError, "group_alias"):
            bundle.validate_group_ids(1001, 1002, 1002)

    def test_filesystem_rejects_wrong_mode_and_symlink(self):
        with self.assertRaisesRegex(ValueError, "filesystem_binding"):
            bundle.validate_fs_record("file", False, 1001, 1001, stat.S_IFREG | 0o640,
                                      "file", 1001, 1001, 0o600)
        with self.assertRaisesRegex(ValueError, "filesystem_binding"):
            bundle.validate_fs_record("file", True, 1001, 1001, stat.S_IFLNK | 0o600,
                                      "file", 1001, 1001, 0o600)

    def test_packaging_is_deterministic_and_requires_clean_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"; root.mkdir()
            for relative in bundle.STATIC:
                target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((relative + "\n").encode())
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "bundle@test.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Bundle Test"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture"], check=True)
            commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
            def fake_build(checkout):
                dist = Path(checkout) / "packages/runners/dist"; dist.mkdir(parents=True)
                for name in bundle.DIST_FIXED | DIST_CHUNKS:
                    (dist / name).write_bytes((name + "\n").encode())
            first = Path(temporary) / "first.tar.gz"; second = Path(temporary) / "second.tar.gz"
            bundle.package(root, commit, first, fake_build); bundle.package(root, commit, second, fake_build)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            caller_dist = root / "packages/runners/dist"; caller_dist.mkdir(parents=True)
            (caller_dist / "stale.js").write_text("caller artifact")
            with self.assertRaisesRegex(ValueError, "caller_dist_forbidden"):
                bundle.package(root, commit, Path(temporary) / "caller.tar.gz", fake_build)
            for path in caller_dist.iterdir(): path.unlink()
            caller_dist.rmdir()
            (root / bundle.STATIC[0]).write_text("dirty")
            with self.assertRaisesRegex(ValueError, "dirty_repo"):
                bundle.package(root, commit, Path(temporary) / "dirty.tar.gz", fake_build)

    def test_packaging_rejects_root_execution(self):
        with mock.patch.object(bundle.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(ValueError, "root_packaging_forbidden"):
                bundle.package("/tmp/source", "a" * 40, "/tmp/output.tar.gz")

    def test_dist_rejects_missing_and_extra_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary)
            for name in bundle.DIST_FIXED | DIST_CHUNKS:
                (dist / name).write_text(name)
            bundle.collect_dist(dist)
            missing_chunk = next(iter(DIST_CHUNKS))
            (dist / missing_chunk).unlink()
            with self.assertRaisesRegex(ValueError, "dist_allowlist"):
                bundle.collect_dist(dist)
            (dist / missing_chunk).write_text(missing_chunk)
            (dist / "index.js").unlink()
            with self.assertRaisesRegex(ValueError, "dist_allowlist"):
                bundle.collect_dist(dist)
            (dist / "index.js").write_text("index")
            (dist / "unexpected.js").write_text("extra")
            with self.assertRaisesRegex(ValueError, "dist_allowlist"):
                bundle.collect_dist(dist)

    def test_dist_rejects_stale_or_tampered_repeat_build(self):
        expected = {name: {"body": name.encode(), "mode": 0o644}
                    for name in bundle.DIST_FIXED | DIST_CHUNKS}
        stale = {name: dict(value) for name, value in expected.items()}
        stale["hermes-executor-cli.js"]["body"] = b"stale-or-tampered"
        with self.assertRaisesRegex(ValueError, "nondeterministic_dist_hash"):
            bundle.compare_dist(expected, stale)

    def test_trusted_build_opens_the_seeded_store_read_only(self):
        self.assertEqual(bundle.PNPM_INSTALL, (
            "install", "--offline", "--frozen-lockfile", "--frozen-store", "--ignore-scripts",
            "--store-dir", bundle.PNPM_STORE,
        ))
        self.assertEqual(
            bundle.build_provenance([])["installPolicy"],
            "offline-frozen-lockfile-frozen-store-ignore-scripts",
        )

    def test_activation_pins_release_outside_production_checkout(self):
        activation = MODULE_PATH.with_name("activate-hermes-runner.sh").read_text()
        self.assertIn('release_root="/opt/fai-control-plane-runner/releases/$release_commit"', activation)
        self.assertNotIn('release_root="/opt/fai-control-plane/releases/', activation)

    def test_units_allow_only_isolated_oauth_homes_beside_operational_paths(self):
        root = MODULE_PATH.parents[1]
        controller = (root / "infra/production/fai-hermes-runner.service").read_text()
        executor = (root / "infra/production/fai-codex-executor.service").read_text()
        self.assertIn(
            "ReadWritePaths=/var/lib/fai-hermes-controller/state "
            "/var/lib/fai-hermes-controller/hermes\n",
            controller,
        )
        controller_writes = next(line for line in controller.splitlines()
                                 if line.startswith("ReadWritePaths="))
        controller_reads = next(line for line in controller.splitlines()
                                if line.startswith("ReadOnlyPaths="))
        self.assertNotIn("hermes/config.yaml", controller_writes)
        self.assertIn("/var/lib/fai-hermes-controller/hermes/config.yaml", controller_reads)
        self.assertIn(
            "ReadWritePaths=/var/lib/fai-codex-executor/repository "
            "/var/lib/fai-codex-executor/worktrees /var/lib/fai-codex-executor/artifacts "
            "/run/fai-hermes-executor /var/lib/fai-codex-executor/codex-home\n",
            executor,
        )
        self.assertIn("UMask=0077\n", executor)
        runtime = "/opt/fai-control-plane-runner/hermes-runtime/0.18.2"
        self.assertIn(f"ReadOnlyPaths=/opt/fai-control-plane-runner/releases/@RELEASE_COMMIT@ {runtime} ", controller)
        self.assertIn(f"ReadOnlyPaths=/opt/fai-control-plane-runner/releases/@RELEASE_COMMIT@ {runtime} ", executor)
        self.assertIn(f"ExecStart={runtime}/venv/bin/python ", executor)
        self.assertNotIn("/root/", controller + executor)
        self.assertNotIn("/usr/local/lib/hermes-agent", controller + executor)
        activation = MODULE_PATH.with_name("activate-hermes-runner.sh").read_text()
        self.assertIn("hermes_runtime=/opt/fai-control-plane-runner/hermes-runtime/0.18.2", activation)
        self.assertIn("assert_unit_path_set fai-hermes-runner.service ReadWritePaths", activation)
        self.assertIn("assert_unit_path_set fai-codex-executor.service ReadWritePaths", activation)


if __name__ == "__main__":
    unittest.main()
