import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace


module_path = Path(__file__).resolve().parents[1] / "src" / "faster_whisper_stt_bridge.py"
spec = importlib.util.spec_from_file_location("faster_whisper_stt_bridge", module_path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        segments = [
            SimpleNamespace(text=" 今天我们 "),
            SimpleNamespace(text="test DeepSeek Harness "),
        ]
        info = SimpleNamespace(language="zh", language_probability=0.91)
        return iter(segments), info


class FasterWhisperBridgeTests(unittest.TestCase):
    def test_transcribes_pcm_and_reports_detected_language(self):
        model = FakeModel()
        pcm = b"\x00\x00\xff\x7f\x00\x80\x00\x00"

        result = bridge.transcribe_pcm(model, pcm, 16000)

        self.assertEqual(result["text"], "今天我们 test DeepSeek Harness")
        self.assertEqual(result["language"], "zh")
        self.assertEqual(result["languageProbability"], 0.91)
        audio, kwargs = model.calls[0]
        self.assertEqual(audio.dtype.name, "float32")
        self.assertEqual(audio.shape, (4,))
        self.assertEqual(kwargs["language"], None)
        self.assertEqual(kwargs["beam_size"], 5)

    def test_response_is_ascii_safe_and_round_trips_mixed_text(self):
        payload = bridge.encode_response({
            "text": "今天 test DeepSeek Harness",
            "language": "zh",
            "languageProbability": 0.8,
        })

        payload.decode("ascii")
        self.assertEqual(json.loads(payload)["text"], "今天 test DeepSeek Harness")


if __name__ == "__main__":
    unittest.main()
