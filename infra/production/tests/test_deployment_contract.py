import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[3]


class DeploymentContractTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
