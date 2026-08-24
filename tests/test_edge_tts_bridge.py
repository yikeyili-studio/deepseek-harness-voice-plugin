import unittest

from src.edge_tts_bridge import DEFAULT_VOICE, parse_request


class ParseRequestTests(unittest.TestCase):
    def test_accepts_fixed_voice(self):
        self.assertEqual(
            parse_request('{"text":" 你好 ","voice":"zh-CN-XiaoxiaoNeural"}'),
            ("你好", "zh-CN-XiaoxiaoNeural"),
        )

    def test_defaults_to_xiaoxiao(self):
        self.assertEqual(
            parse_request('{"text":"你好"}'),
            ("你好", DEFAULT_VOICE),
        )

    def test_rejects_empty_text(self):
        with self.assertRaisesRegex(ValueError, "不能为空"):
            parse_request('{"text":" "}')

    def test_rejects_invalid_json(self):
        with self.assertRaisesRegex(ValueError, "JSON"):
            parse_request("not json")

    def test_rejects_unapproved_voice(self):
        with self.assertRaisesRegex(ValueError, "声音"):
            parse_request('{"text":"你好","voice":"bad"}')

    def test_rejects_over_limit_text(self):
        raw = '{"text":"' + ("字" * 12001) + '"}'
        with self.assertRaisesRegex(ValueError, "12000"):
            parse_request(raw)


if __name__ == "__main__":
    unittest.main()
