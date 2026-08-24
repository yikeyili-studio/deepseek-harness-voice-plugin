import json
import sys
from pathlib import Path

import numpy as np


def encode_response(result: dict) -> bytes:
    return json.dumps(
        result,
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")


def transcribe_pcm(model, pcm: bytes, sample_rate: int) -> dict:
    if sample_rate != 16000:
        raise ValueError("faster-whisper requires 16000 Hz PCM")
    if not pcm or len(pcm) % 2:
        raise ValueError("PCM payload is empty or misaligned")

    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    segments, info = model.transcribe(
        audio,
        language=None,
        beam_size=5,
        condition_on_previous_text=False,
        vad_filter=False,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    text = " ".join(text.split())
    return {
        "text": text,
        "language": str(getattr(info, "language", "") or ""),
        "languageProbability": round(
            float(getattr(info, "language_probability", 0.0) or 0.0),
            6,
        ),
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: faster_whisper_stt_bridge.py MODEL_PATH SAMPLE_RATE", file=sys.stderr)
        return 2

    model_path = Path(sys.argv[1])
    sample_rate = int(sys.argv[2])
    if not model_path.is_dir():
        print(f"faster-whisper model not found: {model_path}", file=sys.stderr)
        return 2

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            str(model_path),
            device="cpu",
            compute_type="int8",
            cpu_threads=6,
        )
        result = transcribe_pcm(model, sys.stdin.buffer.read(), sample_rate)
        sys.stdout.buffer.write(encode_response(result))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
