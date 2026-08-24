import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Whisper test page sends local 16 kHz PCM to its isolated bridge', async () => {
  const html = await readFile(
    new URL('../src/whisper-standalone.html', import.meta.url),
    'utf8',
  );

  assert.match(html, /本地 faster-whisper 中英混合识别测试/);
  assert.match(html, /\/plugins\/dsh-web-voice\/whisper-stt/);
  assert.match(html, /function downsampleTo16k/);
  assert.match(html, /function floatChunksToPcm16/);
  assert.match(html, /content-type': 'application\/octet-stream/);
  assert.match(html, /languageProbability/);
  assert.doesNotMatch(html, /\/plugins\/dsh-web-voice\/stt['"]/);
});
