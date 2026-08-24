# deepseek-harness-voice-plugin

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Made by yikeyili-studio](https://img.shields.io/badge/org-yikeyili--studio-2962FF.svg)](https://github.com/yikeyili-studio)

A **voice input + read-aloud (TTS)** plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **web GUI**. It adds a microphone button beside the composer and a per-assistant-message speaker button, giving the web UI a ChatGPT‑style voice experience.

Compatible with DSH Web (port 3080). MIT-licensed.

## Features

- **Microphone voice input** next to the composer: record Chinese/English mixed speech, transcribe locally, and write the text into the current input box.
- **Per-answer read-aloud (TTS)**: each completed assistant answer gets a speaker button 🔊 that reads it out loud using **Edge TTS** (`zh-CN-XiaoxiaoNeural` by default).
  - Segmented speech for long answers, next-chunk prefetch, stop/resume, 1.25× playback rate.
  - Streams over a local GET route so playback starts with low latency.
  - Edge TTS is an online service — needs network. The speech text is sent to Microsoft's Edge online TTS; the DeepSeek API key is never part of a TTS request.
- Local transcription backends (in order of preference):
  - **faster-whisper** (local, `base` multilingual model) for the current implementation;
  - **vosk** (local Chinese/English model) as a fallback path.
- Clear error states (mic permission, model load, transcription failure, TTS failure) without breaking normal chat.

## Repository layout

```text
src/
  index.js                  # DSH Cordis host plugin: routes + browser injection
  host-core.js              # Request validation + Python bridge process boundary
  edge_tts_bridge.py        # stdin/stdout bridge to edge-tts (MP3 to stdout)
  faster_whisper_stt_bridge.py  # local faster-whisper transcription bridge
  client-core.js            # Browser-side pure helpers (text normalize, ids)
  client.js                 # Browser half: composer mic + per-message read buttons
  styles.css                # Widget styles (inherits Harness theme tokens)
  whisper-standalone.html   # Manual test page for the whisper path
tests/                      # Node + Python unit tests
docs/                       # Design/plan notes (may be GBK-encoded)
```

## Deployment model

The plugin is a user-level Cordis host plugin deployed into the DSH web profile at
`~/.dsh/profiles/web/plugins/dsh-web-voice/`, loaded by a `cordis.patch.yml` entry.

The **source of truth lives under this repository** (`src/`). Deployment copies the
tested `src` runtime files, `package.json`, lockfile, requirements, and installed
runtime dependencies into the live plugin directory after creating a timestamped
rollback snapshot. Large runtime artifacts (the Vosk/faster-whisper models, `vosk.js`,
model archives) are intentionally **not** in this repo (`model/`, `vosk.js`,
`faster-whisper-model/`, `faster-whisper-venv/` are gitignored).

## Requirements / runtime deps

- Node.js (DSH host), Python 3.12
- `edge-tts==7.2.8` (pip)
- `vosk-browser` (npm) or the local faster-whisper model + `faster-whisper` Python env

The deepseek quota widget (`dsh-deepseek-quota`) is a separate package.

## License

MIT — see [LICENSE](LICENSE).
