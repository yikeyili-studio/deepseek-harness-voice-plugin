import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import {
  readBinaryBody,
  readJsonBody,
  runBridge,
  runWhisperBridge,
  validateTtsPayload,
} from '../src/host-core.js';

test('accepts trimmed Chinese text with the fixed voice', () => {
  assert.deepEqual(validateTtsPayload({ text: ' 你好 ' }), {
    text: '你好',
    voice: 'zh-CN-XiaoxiaoNeural',
  });
});

test('rejects empty and over-limit text', () => {
  assert.throws(() => validateTtsPayload({ text: '   ' }), /不能为空/);
  assert.throws(
    () => validateTtsPayload({ text: '字'.repeat(12001) }),
    /12000/,
  );
});

test('rejects an unapproved voice', () => {
  assert.throws(
    () => validateTtsPayload({ text: '你好', voice: 'bad' }),
    /声音/,
  );
});

test('reads one JSON request body within the byte limit', async () => {
  const body = await readJsonBody(
    Readable.from([Buffer.from('{"text":"你好"}', 'utf8')]),
    1024,
  );
  assert.deepEqual(body, { text: '你好' });
});

test('rejects malformed JSON and bodies over the byte limit', async () => {
  await assert.rejects(
    readJsonBody(Readable.from(['not json']), 1024),
    /JSON/,
  );
  await assert.rejects(
    readJsonBody(Readable.from(['123456']), 5),
    /过大/,
  );
});

test('reads binary PCM within the byte limit and rejects oversized input', async () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  assert.deepEqual(await readBinaryBody(Readable.from([pcm]), 4), pcm);
  await assert.rejects(
    readBinaryBody(Readable.from([pcm]), 3),
    /过大/,
  );
});

function fakeChild({ audio = Buffer.alloc(0), stderr = '', code = 0, close = true }) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedByTest = false;
  child.kill = () => {
    child.killedByTest = true;
    child.emit('close', null, 'SIGKILL');
  };

  if (close) {
    queueMicrotask(() => {
      if (audio.length) child.stdout.end(audio);
      else child.stdout.end();
      child.stderr.end(stderr);
      child.emit('close', code, null);
    });
  }
  return child;
}

test('returns bridge MP3 bytes and sends exactly one JSON payload', async () => {
  const child = fakeChild({ audio: Buffer.from('ID3audio') });
  const input = [];
  child.stdin.on('data', (chunk) => input.push(chunk));

  const audio = await runBridge({
    pythonExe: 'python.exe',
    bridgePath: 'bridge.py',
    payload: { text: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
    timeoutMs: 1000,
    spawnImpl: () => child,
  });

  assert.deepEqual(audio, Buffer.from('ID3audio'));
  assert.equal(
    Buffer.concat(input).toString('utf8'),
    '{"text":"你好","voice":"zh-CN-XiaoxiaoNeural"}',
  );
});

test('surfaces bridge stderr on a nonzero exit', async () => {
  await assert.rejects(
    runBridge({
      pythonExe: 'python.exe',
      bridgePath: 'bridge.py',
      payload: { text: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
      timeoutMs: 1000,
      spawnImpl: () => fakeChild({ stderr: 'network failed', code: 2 }),
    }),
    /network failed/,
  );
});

test('rejects a successful bridge process that returns no audio', async () => {
  await assert.rejects(
    runBridge({
      pythonExe: 'python.exe',
      bridgePath: 'bridge.py',
      payload: { text: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
      timeoutMs: 1000,
      spawnImpl: () => fakeChild({ code: 0 }),
    }),
    /没有返回音频/,
  );
});

test('kills a bridge process that exceeds the timeout', async () => {
  const child = fakeChild({ close: false });
  await assert.rejects(
    runBridge({
      pythonExe: 'python.exe',
      bridgePath: 'bridge.py',
      payload: { text: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
      timeoutMs: 10,
      spawnImpl: () => child,
    }),
    /超时/,
  );
  assert.equal(child.killedByTest, true);
});

test('forwards bridge audio before the Edge TTS process closes', async () => {
  const { streamBridge } = await import('../src/host-core.js');
  assert.equal(typeof streamBridge, 'function');

  const child = fakeChild({ close: false });
  const received = [];
  const completion = streamBridge({
    pythonExe: 'python.exe',
    bridgePath: 'bridge.py',
    payload: { text: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
    onAudio: (chunk) => received.push(Buffer.from(chunk)),
    timeoutMs: 1000,
    spawnImpl: () => child,
  });

  child.stdout.write(Buffer.from('first-audio'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Buffer.concat(received).toString(), 'first-audio');

  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
  await completion;
});

test('runs faster-whisper with raw PCM and preserves language metadata', async () => {
  const child = fakeChild({
    audio: Buffer.from(JSON.stringify({
      text: '今天 test DeepSeek Harness',
      language: 'zh',
      languageProbability: 0.91,
    }), 'utf8'),
  });
  const input = [];
  child.stdin.on('data', (chunk) => input.push(chunk));
  let spawned;

  const result = await runWhisperBridge({
    pythonExe: 'python.exe',
    bridgePath: 'faster_whisper_stt_bridge.py',
    modelPath: 'whisper-model',
    pcm: Buffer.from([0, 1, 2, 3]),
    sampleRate: 16000,
    timeoutMs: 1000,
    spawnImpl: (exe, args) => {
      spawned = { exe, args };
      return child;
    },
  });

  assert.deepEqual(result, {
    text: '今天 test DeepSeek Harness',
    language: 'zh',
    languageProbability: 0.91,
  });
  assert.deepEqual(Buffer.concat(input), Buffer.from([0, 1, 2, 3]));
  assert.deepEqual(spawned, {
    exe: 'python.exe',
    args: ['faster_whisper_stt_bridge.py', 'whisper-model', '16000'],
  });
});
