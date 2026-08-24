import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

import * as core from '../src/client-core.js';

const clientSource = await readFile(
  new URL('../src/client.js', import.meta.url),
  'utf8',
);

function waitForDomWork(window) {
  return new Promise((resolve) => window.setTimeout(resolve, 10));
}

test('adds one composer microphone and one read button per assistant response', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-chat-flow-key="assistant-step" data-dsh-message-key="turn-1">
      <div class="answer">这是一条回答。<pre>const secret = 1;</pre></div>
      <div class="actions">
        <button type="button" aria-label="复制">复制</button>
        <button type="button" aria-label="好的回答">好</button>
        <button type="button" aria-label="有问题的回答">差</button>
      </div>
    </section>
    <section data-composer-card>
      <textarea></textarea>
      <div class="composer-actions"><button aria-label="发送">发送</button></div>
    </section>
  </body></html>`, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:3080/',
  });

  const { window } = dom;
  window.__DSH_EDGE_VOICE_CORE__ = core;
  const requests = [];
  const played = [];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      blob: async () => new window.Blob(['ID3audio'], { type: 'audio/mpeg' }),
    };
  };
  window.URL.createObjectURL = () => 'blob:test-audio';
  window.URL.revokeObjectURL = () => {};
  window.Audio = class FakeAudio {
    constructor(src) {
      this.src = src;
      this.paused = true;
    }
    async play() {
      this.paused = false;
      played.push(this);
    }
    pause() {
      this.paused = true;
    }
    load() {
      this.loaded = true;
    }
  };

  window.eval(clientSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitForDomWork(window);

  assert.equal(window.document.querySelectorAll('[data-dsh-edge-mic]').length, 1);
  assert.equal(window.document.querySelectorAll('[data-dsh-edge-read]').length, 1);

  window.document.body.append(window.document.createElement('span'));
  await waitForDomWork(window);
  assert.equal(window.document.querySelectorAll('[data-dsh-edge-mic]').length, 1);
  assert.equal(window.document.querySelectorAll('[data-dsh-edge-read]').length, 1);

  window.document.querySelector('[data-dsh-edge-read]').click();
  await waitForDomWork(window);

  assert.equal(requests.length, 0);
  const audioUrl = new URL(played[0].src, 'http://127.0.0.1:3080');
  assert.equal(audioUrl.pathname, '/plugins/dsh-web-voice/tts');
  assert.equal(audioUrl.searchParams.get('text'), '这是一条回答。');
  assert.equal(played[0].playbackRate, 1.25);
});

test('adds a read button to an icon-only Harness action row without aria labels', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-chat-flow-key="assistant-step">
      <div class="answer">图标操作栏也要能朗读。</div>
      <div class="p-xYUq_actions osXY9a_actions">
        <button type="button">复制</button><button type="button">好</button><button type="button">差</button>
      </div>
    </section>
    <section data-composer-card><textarea></textarea><div><button aria-label="发送">发送</button></div></section>
  </body></html>`, { runScripts: 'outside-only', url: 'http://127.0.0.1:3080/' });
  const { window } = dom;
  window.__DSH_EDGE_VOICE_CORE__ = core;
  window.eval(clientSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitForDomWork(window);
  assert.equal(window.document.querySelectorAll('[data-dsh-edge-read]').length, 1);
});

test('adds a read button to the separate turn-tail used by current Harness', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-chat-flow>
      <div data-chat-flow-key="14:assistant-step4:3" data-chat-flow-kind="assistant-step">
        <div class="answer">这是当前 Harness 的回答。</div>
      </div>
      <div data-chat-flow-key="9:turn-tail4" data-chat-flow-kind="turn-tail">
        <div class="osXY9a_root">
          <div class="p-xYUq_actions osXY9a_actions">
            <button aria-label="复制"></button>
            <button aria-label="好的回答"></button>
            <button aria-label="有问题的回答"></button>
          </div>
          <div class="p-xYUq_actions osXY9a_actions">用时 20 秒</div>
        </div>
      </div>
    </div>
    <section data-composer-card><textarea></textarea><div><button aria-label="发送">发送</button></div></section>
  </body></html>`, { runScripts: 'outside-only', url: 'http://127.0.0.1:3080/' });
  const { window } = dom;
  window.__DSH_EDGE_VOICE_CORE__ = core;
  window.eval(clientSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitForDomWork(window);

  const tail = window.document.querySelector('[data-chat-flow-kind="turn-tail"]');
  assert.equal(tail.querySelectorAll('[data-dsh-edge-read]').length, 1);
});

test('starts a long answer with a short chunk and prefetches the next chunk', async () => {
  const longText = `${'第一句。'.repeat(900)}最后一句。`;
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-chat-flow-key="assistant-step">
      <div class="answer">${longText}</div>
      <div class="actions"><button type="button" aria-label="复制">复制</button></div>
    </section>
    <section data-composer-card><textarea></textarea><div><button aria-label="发送">发送</button></div></section>
  </body></html>`, { runScripts: 'outside-only', url: 'http://127.0.0.1:3080/' });

  const { window } = dom;
  window.__DSH_EDGE_VOICE_CORE__ = core;
  const requests = [];
  const audios = [];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, blob: async () => new window.Blob(['ID3audio'], { type: 'audio/mpeg' }) };
  };
  let urlNumber = 0;
  window.URL.createObjectURL = () => `blob:chunk-${++urlNumber}`;
  window.URL.revokeObjectURL = () => {};
  window.Audio = class FakeAudio {
    constructor(src) { this.src = src; this.paused = true; audios.push(this); }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    load() { this.loaded = true; }
  };

  window.eval(clientSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitForDomWork(window);
  const button = window.document.querySelector('[data-dsh-edge-read]');
  button.click();
  await waitForDomWork(window);

  assert.equal(requests.length, 0);
  assert.ok(audios.length >= 2);
  const firstAudioUrl = new URL(audios[0].src, 'http://127.0.0.1:3080');
  assert.ok(firstAudioUrl.searchParams.get('text').length <= 200);
  assert.equal(audios[1].loaded, true);
  assert.equal(button.getAttribute('data-state'), 'playing');

  audios[0].onended();
  await waitForDomWork(window);
  assert.equal(audios[1].paused, false);

  button.click();
  assert.equal(button.getAttribute('data-state'), 'idle');
  assert.equal(audios[1].paused, true);
});

test('sends 16 kHz PCM to local faster-whisper and inserts mixed-language text', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-composer-card>
      <textarea></textarea>
      <div><button aria-label="发送">发送</button></div>
    </section>
  </body></html>`, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:3080/',
  });

  const { window } = dom;
  window.__DSH_EDGE_VOICE_CORE__ = core;
  const requests = [];
  window.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/plugins/dsh-web-voice/whisper-stt') {
      return {
        ok: true,
        json: async () => ({ text: '今天 test 一下 DeepSeek Harness' }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop() {} }],
      }),
    },
  });

  let processor;
  const audioNode = () => ({
    connect() {},
    disconnect() {},
    onaudioprocess: null,
  });
  window.AudioContext = class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.destination = audioNode();
    }
    createScriptProcessor() { processor = audioNode(); return processor; }
    createMediaStreamSource() { return audioNode(); }
    createMediaStreamDestination() { return audioNode(); }
    createGain() { return { ...audioNode(), gain: { value: 1 } }; }
    close() {}
  };

  window.eval(clientSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitForDomWork(window);

  const microphone = window.document.querySelector('[data-dsh-edge-mic]');
  microphone.click();
  await waitForDomWork(window);
  processor.onaudioprocess({
    inputBuffer: {
      getChannelData: () => Float32Array.from({ length: 9600 }, (_, index) => (
        index % 2 === 0 ? 0.1 : -0.1
      )),
    },
  });
  microphone.click();
  await new Promise((resolve) => window.setTimeout(resolve, 30));

  const sttRequest = requests.find((request) => (
    request.url === '/plugins/dsh-web-voice/whisper-stt'
  ));
  assert.equal(
    window.document.querySelector('textarea').value,
    '今天 test 一下 DeepSeek Harness',
  );
  assert.ok(sttRequest);
  assert.equal(sttRequest.options.headers['content-type'], 'application/octet-stream');
  assert.equal(sttRequest.options.body.byteLength, 6400);
});

test('reports recorded audio when faster-whisper returns no text', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-composer-card>
      <textarea></textarea>
      <div><button aria-label="发送">发送</button></div>
    </section>
  </body></html>`, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:3080/',
  });

  const { window } = dom;
  window.__DSH_EDGE_VOICE_CORE__ = core;
  const diagnostics = [];
  window.fetch = async (url, options) => {
    if (url === '/plugins/dsh-web-voice/diagnostics') {
      diagnostics.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url === '/plugins/dsh-web-voice/whisper-stt') {
      return { ok: true, json: async () => ({ text: '' }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    },
  });

  let processor;
  const audioNode = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
  window.AudioContext = class FakeAudioContext {
    constructor() { this.sampleRate = 48000; this.destination = audioNode(); }
    createScriptProcessor() { processor = audioNode(); return processor; }
    createMediaStreamSource() { return audioNode(); }
    createMediaStreamDestination() { return audioNode(); }
    createGain() { return { ...audioNode(), gain: { value: 1 } }; }
    close() {}
  };

  window.eval(clientSource);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitForDomWork(window);

  const microphone = window.document.querySelector('[data-dsh-edge-mic]');
  microphone.click();
  await waitForDomWork(window);
  processor.onaudioprocess({
    inputBuffer: {
      getChannelData: () => Float32Array.from({ length: 9600 }, () => 0.1),
    },
  });
  microphone.click();
  await new Promise((resolve) => window.setTimeout(resolve, 30));

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].reason, 'no_recognition');
  assert.equal(diagnostics[0].audioCallbacks, 1);
  assert.equal(diagnostics[0].audioSamples, 9600);
  assert.ok(diagnostics[0].rms > 0.05);
  assert.ok(diagnostics[0].peak >= 0.1);
  assert.equal(diagnostics[0].sampleRate, 48000);
});
