import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("bridge_state", ROOT / "extensions/fai-control-plane/bridge_state.py")
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)


class BridgeStateTest(unittest.TestCase):
    def setUp(self):
        STATE.reset_for_test()

    def test_promotes_exact_post_auth_identity_without_text(self):
        STATE.stage(platform="telegram", user_id="96211907", chat_id="-5540760630", update_id="77", message_id="12")
        self.assertTrue(STATE.promote(platform="telegram", user_id="96211907", chat_id="-5540760630", session_id="s1"))
        self.assertEqual(STATE.resolve("s1")["updateId"], "77")
        self.assertNotIn("text", STATE.resolve("s1"))

    def test_does_not_promote_another_sender(self):
        STATE.stage(platform="telegram", user_id="96211907", chat_id="-5540760630", update_id="77", message_id="12")
        self.assertFalse(STATE.promote(platform="telegram", user_id="1", chat_id="-5540760630", session_id="s1"))
        self.assertIsNone(STATE.resolve("s1"))


if __name__ == "__main__":
    unittest.main()
