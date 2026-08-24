"""Small stdin/stdout bridge from the DSH host plugin to edge-tts."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any


DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
MAX_TEXT_LENGTH = 12_000


def parse_request(raw: str) -> tuple[str, str]:
    try:
        payload: Any = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("请求内容不是有效 JSON") from exc

    if not isinstance(payload, dict):
        raise ValueError("请求内容必须是 JSON 对象")

    raw_text = payload.get("text")
    text = raw_text.strip() if isinstance(raw_text, str) else ""
    voice = payload.get("voice", DEFAULT_VOICE)

    if not text:
        raise ValueError("朗读文字不能为空")
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError("朗读文字不能超过 12000 字")
    if voice != DEFAULT_VOICE:
        raise ValueError("不支持这个声音")

    return text, voice


async def synthesize(text: str, voice: str) -> None:
    import edge_tts

    audio_bytes = 0
    communicate = edge_tts.Communicate(text, voice)
    async for chunk in communicate.stream():
        if chunk["type"] != "audio":
            continue
        data = chunk["data"]
        sys.stdout.buffer.write(data)
        audio_bytes += len(data)

    if audio_bytes == 0:
        raise RuntimeError("Edge TTS 没有返回音频")
    sys.stdout.buffer.flush()


def main() -> int:
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        text, voice = parse_request(raw)
        asyncio.run(synthesize(text, voice))
        return 0
    except Exception as exc:  # noqa: BLE001 - this is a process boundary.
        print(f"Edge TTS 失败：{exc}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
