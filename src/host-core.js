import { spawn } from 'node:child_process';

// The DSH host process may inherit proxy environment variables (HTTP_PROXY /
// HTTPS_PROXY / ALL_PROXY / WS_PROXY / WSS_PROXY). Edge TTS is an online
// service; if that proxy points at a local port that is not currently
// listening (for example a proxy client that is stopped), the Python bridge
// cannot reach Microsoft and produces zero audio bytes, which surfaces in the
// browser as "Failed to load because no supported source was found." These
// bridge processes should ignore the inherited proxy so Edge TTS can connect
// directly. Only this child process is affected; the host and other apps keep
// whatever proxy configuration they had.
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'WS_PROXY',
  'WSS_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'ws_proxy',
  'wss_proxy',
];

function cleanProxyEnv() {
  const cleaned = { ...process.env };
  for (const key of PROXY_ENV_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
export const MAX_TEXT_LENGTH = 12000;

export function validateTtsPayload(payload) {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  const voice = payload?.voice ?? DEFAULT_VOICE;

  if (!text) {
    throw new Error('朗读文字不能为空');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error('朗读文字不能超过 12000 字');
  }
  if (voice !== DEFAULT_VOICE) {
    throw new Error('不支持这个声音');
  }

  return { text, voice };
}

export async function readJsonBody(req, maxBytes = 64 * 1024) {
  const body = await readBinaryBody(req, maxBytes);

  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('请求内容不是有效 JSON');
  }
}

export async function readBinaryBody(req, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new Error('请求内容过大');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function runBridge({
  pythonExe,
  bridgePath,
  payload,
  timeoutMs = 30000,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(pythonExe, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: cleanProxyEnv(),
    });
    const audioChunks = [];
    const errorChunks = [];
    let errorBytes = 0;
    let settled = false;

    const finish = (error, audio) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(audio);
    };

    child.stdout.on('data', (chunk) => {
      audioChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      if (errorBytes >= 8192) return;
      const bytes = Buffer.from(chunk);
      const remaining = 8192 - errorBytes;
      errorChunks.push(bytes.subarray(0, remaining));
      errorBytes += Math.min(bytes.length, remaining);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(errorChunks).toString('utf8').trim();
      if (code !== 0) {
        finish(new Error(stderr || `Edge TTS 进程失败（code=${code}, signal=${signal ?? 'none'}）`));
        return;
      }
      const audio = Buffer.concat(audioChunks);
      if (!audio.length) {
        finish(new Error('Edge TTS 没有返回音频'));
        return;
      }
      finish(null, audio);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      finish(new Error('Edge TTS 生成超时'));
      try {
        child.kill('SIGKILL');
      } catch {
        // The timeout is already reported; failure to kill cannot replace it.
      }
    }, timeoutMs);

    child.stdin.end(JSON.stringify(payload));
  });
}

export function streamBridge({
  pythonExe,
  bridgePath,
  payload,
  onAudio,
  timeoutMs = 30000,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(pythonExe, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: cleanProxyEnv(),
    });
    const errorChunks = [];
    let errorBytes = 0;
    let audioBytes = 0;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ audioBytes });
    };

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      audioBytes += bytes.length;
      try {
        onAudio(bytes);
      } catch (error) {
        finish(error);
        try { child.kill('SIGKILL'); } catch (_killError) {}
      }
    });
    child.stderr.on('data', (chunk) => {
      if (errorBytes >= 8192) return;
      const bytes = Buffer.from(chunk);
      const remaining = 8192 - errorBytes;
      errorChunks.push(bytes.subarray(0, remaining));
      errorBytes += Math.min(bytes.length, remaining);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(errorChunks).toString('utf8').trim();
      if (code !== 0) {
        finish(new Error(stderr || `Edge TTS 进程失败（code=${code}, signal=${signal ?? 'none'}）`));
        return;
      }
      if (!audioBytes) {
        finish(new Error('Edge TTS 没有返回音频'));
        return;
      }
      finish(null);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      finish(new Error('Edge TTS 生成超时'));
      try { child.kill('SIGKILL'); } catch (_error) {}
    }, timeoutMs);

    child.stdin.end(JSON.stringify(payload));
  });
}

export function runWhisperBridge({
  pythonExe,
  bridgePath,
  modelPath,
  pcm,
  sampleRate = 16000,
  timeoutMs = 60000,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      pythonExe,
      [bridgePath, modelPath, String(sampleRate)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const outputChunks = [];
    const errorChunks = [];
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout.on('data', (chunk) => outputChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => {
      if (Buffer.concat(errorChunks).length < 16384) errorChunks.push(Buffer.from(chunk));
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      const stderr = Buffer.concat(errorChunks).toString('utf8').trim();
      if (code !== 0) {
        finish(new Error(stderr || `本地语音模型进程失败（code=${code}, signal=${signal ?? 'none'}）`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(outputChunks).toString('utf8'));
        const result = { text: typeof parsed.text === 'string' ? parsed.text.trim() : '' };
        if (typeof parsed.language === 'string') {
          result.language = parsed.language.trim();
        }
        if (Number.isFinite(parsed.languageProbability)) {
          result.languageProbability = parsed.languageProbability;
        }
        finish(null, result);
      } catch {
        finish(new Error('本地语音模型没有返回有效 JSON'));
      }
    });

    const timer = setTimeout(() => {
      finish(new Error('本地语音模型识别超时'));
      try { child.kill('SIGKILL'); } catch (_error) {}
    }, timeoutMs);

    child.stdin.end(pcm);
  });
}
