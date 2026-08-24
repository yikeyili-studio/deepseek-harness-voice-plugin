import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';

test('registers only faster-whisper and Edge TTS routes', () => {
  const routes = [];
  let indexTap;
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
      },
      tapIndex(callback) {
        indexTap = callback;
      },
    },
  };

  apply(ctx);

  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [
      '/plugins/dsh-web-voice/diagnostics',
      '/plugins/dsh-web-voice/health',
      '/plugins/dsh-web-voice/tts',
      '/plugins/dsh-web-voice/whisper-stt',
      '/plugins/dsh-web-voice/whisper-test',
    ],
  );

  const once = indexTap('<html><body><main>Harness</main></body></html>');
  const twice = indexTap(once);
  assert.match(once, /id="dsh-edge-voice"/);
  assert.doesNotMatch(once, /dsh-voice-bar/);
  assert.equal((twice.match(/id="dsh-edge-voice"/g) ?? []).length, 1);
  assert.equal(indexTap('<html><main>partial</main></html>'), '<html><main>partial</main></html>');
});
