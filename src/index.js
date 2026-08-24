import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readBinaryBody,
  readJsonBody,
  runBridge,
  streamBridge,
  runWhisperBridge,
  validateTtsPayload,
} from './host-core.js';

const name = 'web-voice';
const inject = ['webServer'];
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(PLUGIN_DIR, 'edge_tts_bridge.py');
const WHISPER_BRIDGE_PATH = join(PLUGIN_DIR, 'faster_whisper_stt_bridge.py');
const WHISPER_STANDALONE_PATH = join(PLUGIN_DIR, 'whisper-standalone.html');
const PYTHON_EXE = process.env.DSH_EDGE_TTS_PYTHON || join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'Python',
  'Python312',
  'python.exe',
);
const WHISPER_PYTHON_EXE = process.env.DSH_FASTER_WHISPER_PYTHON || join(
  process.cwd(),
  'faster-whisper-venv',
  'Scripts',
  'python.exe',
);
const WHISPER_MODEL_PATH = process.env.DSH_FASTER_WHISPER_MODEL || join(
  process.cwd(),
  'faster-whisper-model',
);

const ROUTES = {
  diagnostics: '/plugins/dsh-web-voice/diagnostics',
  whisperStt: '/plugins/dsh-web-voice/whisper-stt',
  whisperTest: '/plugins/dsh-web-voice/whisper-test',
  tts: '/plugins/dsh-web-voice/tts',
  health: '/plugins/dsh-web-voice/health',
};

let latestRecognitionDiagnostics = {
  status: 'waiting_for_test',
  updatedAt: null,
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function fileHandler(filePath, contentType, cacheControl) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'asset_not_installed' });
      return;
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(statSync(filePath).size),
      'cache-control': cacheControl,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  };
}

async function ttsHandler(req, res) {
  if (req.method === 'GET') {
    let started = false;
    try {
      const requestUrl = new URL(req.url || ROUTES.tts, 'http://127.0.0.1');
      const payload = validateTtsPayload({
        text: requestUrl.searchParams.get('text'),
        voice: requestUrl.searchParams.get('voice') || undefined,
      });
      await streamBridge({
        pythonExe: PYTHON_EXE,
        bridgePath: BRIDGE_PATH,
        payload,
        timeoutMs: 30000,
        onAudio(chunk) {
          if (!started) {
            started = true;
            res.writeHead(200, {
              'content-type': 'audio/mpeg',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            });
          }
          res.write(chunk);
        },
      });
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started) {
        res.destroy(error instanceof Error ? error : new Error(message));
      } else {
        const status = /超时/.test(message) ? 504 : /文字|声音|请求/.test(message) ? 400 : 500;
        sendJson(res, status, { error: message });
      }
    }
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '请使用 GET 或 POST 请求' });
    return;
  }
  if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 400, { error: '请求必须使用 application/json' });
    return;
  }

  try {
    const body = await readJsonBody(req, 64 * 1024);
    const payload = validateTtsPayload(body);
    const audio = await runBridge({
      pythonExe: PYTHON_EXE,
      bridgePath: BRIDGE_PATH,
      payload,
      timeoutMs: 30000,
    });
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': String(audio.length),
      'cache-control': 'no-store',
    });
    res.end(audio);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /超时/.test(message) ? 504 : /请求|文字|声音|JSON|过大/.test(message) ? 400 : 500;
    sendJson(res, status, { error: message });
  }
}

async function whisperSttHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '请使用 POST 请求' });
    return;
  }
  if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) {
    sendJson(res, 400, { error: '语音请求必须使用 application/octet-stream' });
    return;
  }

  try {
    const pcm = await readBinaryBody(req, 8 * 1024 * 1024);
    if (pcm.length < 3200 || pcm.length % 2 !== 0) {
      throw new Error('PCM 语音过短或格式无效');
    }
    const result = await runWhisperBridge({
      pythonExe: WHISPER_PYTHON_EXE,
      bridgePath: WHISPER_BRIDGE_PATH,
      modelPath: WHISPER_MODEL_PATH,
      pcm,
      sampleRate: 16000,
      timeoutMs: 120000,
    });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /超时/.test(message) ? 504 : /请求|PCM|过短|格式|过大/.test(message) ? 400 : 500;
    sendJson(res, status, { error: message });
  }
}

function healthHandler(_req, res) {
  const health = {
    edgeTtsBridge: existsSync(BRIDGE_PATH),
    python: existsSync(PYTHON_EXE),
    fasterWhisperBridge: existsSync(WHISPER_BRIDGE_PATH),
    fasterWhisperPython: existsSync(WHISPER_PYTHON_EXE),
    fasterWhisperModel: existsSync(WHISPER_MODEL_PATH),
  };
  const ok = Object.values(health).every(Boolean);
  sendJson(res, ok ? 200 : 503, { ok, ...health });
}

function diagnosticNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function diagnosticsHandler(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, latestRecognitionDiagnostics);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 400, { error: '请求必须使用 application/json' });
    return;
  }

  try {
    const body = await readJsonBody(req, 8 * 1024);
    latestRecognitionDiagnostics = {
      status: 'complete',
      updatedAt: new Date().toISOString(),
      reason: String(body.reason || 'unknown').slice(0, 40),
      audioCallbacks: diagnosticNumber(body.audioCallbacks),
      audioSamples: diagnosticNumber(body.audioSamples),
      rms: diagnosticNumber(body.rms),
      peak: diagnosticNumber(body.peak),
      sampleRate: diagnosticNumber(body.sampleRate),
      partialEvents: diagnosticNumber(body.partialEvents),
      resultEvents: diagnosticNumber(body.resultEvents),
      finalTextLength: diagnosticNumber(body.finalTextLength),
      partialTextLength: diagnosticNumber(body.partialTextLength),
      elapsedMs: diagnosticNumber(body.elapsedMs),
    };
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function browserBundle() {
  const styles = readFileSync(join(PLUGIN_DIR, 'styles.css'), 'utf8');
  const coreSource = readFileSync(join(PLUGIN_DIR, 'client-core.js'), 'utf8')
    .replace(/^export\s+/gm, '');
  const clientSource = readFileSync(join(PLUGIN_DIR, 'client.js'), 'utf8');
  const coreBootstrap = `${coreSource}\nwindow.__DSH_EDGE_VOICE_CORE__ = { normalizeReadableText, voiceButtonId };`;
  return [
    '<style id="dsh-edge-voice-style">',
    styles,
    '</style>',
    '<script id="dsh-edge-voice">',
    `(function(){${coreBootstrap}})();`,
    clientSource,
    '</script>',
  ].join('\n');
}

function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.whisperTest,
    handler: fileHandler(WHISPER_STANDALONE_PATH, 'text/html; charset=utf-8', 'no-store'),
  });
  ctx.webServer.register({ kind: 'exact', path: ROUTES.tts, handler: ttsHandler });
  ctx.webServer.register({ kind: 'exact', path: ROUTES.whisperStt, handler: whisperSttHandler });
  ctx.webServer.register({ kind: 'exact', path: ROUTES.health, handler: healthHandler });
  ctx.webServer.register({ kind: 'exact', path: ROUTES.diagnostics, handler: diagnosticsHandler });

  ctx.webServer.tapIndex((html) => {
    if (typeof html !== 'string' || !html.includes('</body>')) return html;
    if (html.includes('id="dsh-edge-voice"')) return html;
    return html.replace('</body>', `${browserBundle()}\n</body>`);
  });
}

export { apply, inject, name };
