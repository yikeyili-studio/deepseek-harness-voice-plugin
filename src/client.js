(function () {
  'use strict';

  if (window.__dshEdgeVoiceLoaded) return;
  window.__dshEdgeVoiceLoaded = true;

  var core = window.__DSH_EDGE_VOICE_CORE__;
  if (!core) return;

  var TTS_URL = '/plugins/dsh-web-voice/tts';
  var DIAGNOSTICS_URL = '/plugins/dsh-web-voice/diagnostics';
  var WHISPER_STT_URL = '/plugins/dsh-web-voice/whisper-stt';
  var VOICE = 'zh-CN-XiaoxiaoNeural';
  var recording = null;
  var playing = null;
  var messageCounter = 0;
  var reconcileQueued = false;

  function composerCard() {
    var cards = document.querySelectorAll('[data-composer-card]');
    if (cards.length) return cards[cards.length - 1];
    var textarea = document.querySelector('textarea');
    return textarea ? textarea.parentElement : null;
  }

  function composerTextarea(card) {
    return card ? card.querySelector('textarea') : null;
  }

  function statusElement() {
    var card = composerCard();
    if (!card) return null;
    var status = card.querySelector('[data-dsh-edge-status]');
    if (!status) {
      status = document.createElement('span');
      status.setAttribute('data-dsh-edge-status', '');
      card.appendChild(status);
    }
    return status;
  }

  function setStatus(text, isError) {
    var status = statusElement();
    if (!status) return;
    status.textContent = text || '';
    status.setAttribute('data-error', isError ? 'true' : 'false');
  }

  function nativeSetText(textarea, text) {
    var descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    );
    if (descriptor && descriptor.set) descriptor.set.call(textarea, text);
    else textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.focus();
  }

  function stopRecordingCapture(state) {
    if (!state) return;
    if (state.processor) {
      try { state.processor.disconnect(); } catch (_error) {}
      state.processor.onaudioprocess = null;
    }
    if (state.source) {
      try { state.source.disconnect(); } catch (_error) {}
    }
    if (state.gain) {
      try { state.gain.disconnect(); } catch (_error) {}
    }
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) { track.stop(); });
    }
    if (state.audioContext) {
      try { state.audioContext.close(); } catch (_error) {}
    }
  }

  function downsampleTo16k(input, inputRate) {
    if (inputRate === 16000) return new Float32Array(input);
    var ratio = inputRate / 16000;
    var outputLength = Math.max(1, Math.floor(input.length / ratio));
    var output = new Float32Array(outputLength);
    for (var outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
      var start = Math.floor(outputIndex * ratio);
      var end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
      var sum = 0;
      for (var inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex];
      output[outputIndex] = end > start ? sum / (end - start) : input[start] || 0;
    }
    return output;
  }

  function floatChunksToPcm16(chunks) {
    var sampleCount = chunks.reduce(function (total, chunk) { return total + chunk.length; }, 0);
    var pcm = new Int16Array(sampleCount);
    var offset = 0;
    chunks.forEach(function (chunk) {
      for (var index = 0; index < chunk.length; index += 1) {
        var sample = Math.max(-1, Math.min(1, chunk[index]));
        pcm[offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
    });
    return pcm;
  }

  function recognitionDiagnostics(state, text, error) {
    var sampleCount = state.audioSamples || 0;
    var rms = sampleCount ? Math.sqrt(state.audioSumSquares / sampleCount) : 0;
    var reason = error ? 'capture_error'
      : text ? 'recognized'
      : !state.audioCallbacks ? 'no_audio_callbacks'
      : rms < 0.003 && state.audioPeak < 0.02 ? 'silent_audio'
      : 'no_recognition';
    return {
      reason: reason,
      audioCallbacks: state.audioCallbacks || 0,
      audioSamples: sampleCount,
      rms: Number(rms.toFixed(6)),
      peak: Number((state.audioPeak || 0).toFixed(6)),
      sampleRate: state.audioContext && state.audioContext.sampleRate || 0,
      partialEvents: 0,
      resultEvents: text ? 1 : 0,
      finalTextLength: text.length,
      partialTextLength: 0,
      elapsedMs: Math.max(0, Date.now() - state.startedAt)
    };
  }

  function publishDiagnostics(details) {
    if (typeof fetch !== 'function') return;
    try {
      fetch(DIAGNOSTICS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(details)
      }).catch(function () {});
    } catch (_error) {}
  }

  function emptyRecognitionMessage(details) {
    if (details.reason === 'no_audio_callbacks') {
      return '诊断：麦克风已授权，但浏览器没有产生音频回调';
    }
    if (details.reason === 'silent_audio') {
      return '诊断：收到了录音数据，但音量接近静音；请检查输入设备和系统音量';
    }
    return '诊断：已录到声音（RMS ' + details.rms + '），但本地中英混合模型没有返回文字';
  }

  async function stopRecording(error) {
    var state = recording;
    if (!state) return;
    recording = null;
    stopRecordingCapture(state);
    state.button.setAttribute('data-state', 'idle');
    state.button.textContent = '🎤';
    state.button.title = '语音输入';

    if (error) {
      publishDiagnostics(recognitionDiagnostics(state, '', error));
      setStatus(error.message || String(error), true);
      return;
    }
    var pcm = floatChunksToPcm16(state.pcmChunks);
    if (pcm.byteLength < 3200) {
      var shortDetails = recognitionDiagnostics(state, '', null);
      publishDiagnostics(shortDetails);
      setStatus('录音太短，请至少说话一秒', true);
      return;
    }
    setStatus('本机中英混合模型正在转写…');
    try {
      var response = await fetch(WHISPER_STT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: pcm.buffer
      });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || '本地转写失败');
      var text = typeof result.text === 'string' ? result.text.trim() : '';
      var details = recognitionDiagnostics(state, text, null);
      publishDiagnostics(details);
      if (!text) {
        setStatus(emptyRecognitionMessage(details), true);
        return;
      }
      var textarea = composerTextarea(composerCard());
      if (!textarea || textarea.disabled || textarea.readOnly) {
        setStatus('当前输入框不可编辑', true);
        return;
      }
      nativeSetText(textarea, text);
      setStatus('已输入：' + text.slice(0, 40));
    } catch (failure) {
      publishDiagnostics(recognitionDiagnostics(state, '', failure));
      setStatus('转写失败：' + (failure && failure.message ? failure.message : failure), true);
    }
  }

  async function startRecording(button) {
    button.setAttribute('data-state', 'loading');
    button.textContent = '…';
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        }
      });
      var AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      var audioContext = new AudioContextImpl();
      if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
        await audioContext.resume();
      }
      var state = {
        button: button,
        stream: stream,
        audioContext: audioContext,
        startedAt: Date.now(),
        audioCallbacks: 0,
        audioSamples: 0,
        audioSumSquares: 0,
        audioPeak: 0,
        pcmChunks: [],
        processor: null,
        source: null,
        gain: null
      };
      recording = state;
      state.processor = audioContext.createScriptProcessor(4096, 1, 1);
      state.processor.onaudioprocess = function (event) {
        if (recording !== state) return;
        try {
          var samples = event.inputBuffer.getChannelData(0);
          state.audioCallbacks += 1;
          state.audioSamples += samples.length;
          for (var index = 0; index < samples.length; index += 1) {
            var sample = samples[index];
            state.audioSumSquares += sample * sample;
            state.audioPeak = Math.max(state.audioPeak, Math.abs(sample));
          }
          state.pcmChunks.push(downsampleTo16k(samples, audioContext.sampleRate));
        } catch (error) {
          queueMicrotask(function () { stopRecording(error); });
        }
      };
      state.source = audioContext.createMediaStreamSource(stream);
      state.gain = audioContext.createGain();
      state.gain.gain.value = 0;
      state.source.connect(state.processor);
      state.processor.connect(state.gain);
      state.gain.connect(audioContext.destination);
      button.setAttribute('data-state', 'recording');
      button.textContent = '⏹';
      button.title = '停止中英混合语音输入';
      setStatus('正在聆听；说完后再次点击麦克风');
    } catch (error) {
      button.setAttribute('data-state', 'idle');
      button.textContent = '🎤';
      var message = error && error.name === 'NotAllowedError'
        ? '请允许 127.0.0.1:3080 使用麦克风'
        : '语音输入失败：' + (error && error.message ? error.message : error);
      setStatus(message, true);
    }
  }

  function toggleRecording(button) {
    if (recording) {
      stopRecording();
      return;
    }
    startRecording(button);
  }

  function ensureMicrophone() {
    var card = composerCard();
    if (!card || card.querySelector('[data-dsh-edge-mic]')) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '🎤';
    button.title = '语音输入';
    button.setAttribute('aria-label', '语音输入');
    button.setAttribute('data-dsh-edge-mic', '');
    button.setAttribute('data-state', 'idle');
    button.addEventListener('click', function () { toggleRecording(button); });

    var sendButton = card.querySelector('button[aria-label*="发送"], button[aria-label*="Send"]');
    var actions = sendButton ? sendButton.parentElement : card;
    if (sendButton && actions) actions.insertBefore(button, sendButton);
    else actions.appendChild(button);
  }

  function stopPlayback() {
    if (!playing) return;
    var current = playing;
    playing = null;
    (current.audios || []).forEach(function (audio) {
      if (!audio) return;
      try { audio.pause(); } catch (_error) {}
    });
    current.button.textContent = '🔊';
    current.button.title = '朗读这条回答';
    current.button.setAttribute('data-state', 'idle');
  }

  function readableChunks(text, firstMaxLength, nextMaxLength) {
    var remaining = core.normalizeReadableText(text);
    var chunks = [];
    while (remaining) {
      var maxLength = chunks.length ? nextMaxLength : firstMaxLength;
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      var boundary = -1;
      var searchStart = Math.max(0, maxLength - 400);
      for (var index = maxLength - 1; index >= searchStart; index -= 1) {
        if (/[。！？!?；;，,\s]/.test(remaining.charAt(index))) {
          boundary = index + 1;
          break;
        }
      }
      if (boundary < 1) boundary = maxLength;
      chunks.push(remaining.slice(0, boundary).trim());
      remaining = remaining.slice(boundary).trim();
    }
    return chunks;
  }

  function prepareSpeechChunk(state, index) {
    if (index >= state.chunks.length) return null;
    if (!state.audios[index]) {
      var query = '?text=' + encodeURIComponent(state.chunks[index])
        + '&voice=' + encodeURIComponent(VOICE);
      var audio = new Audio(TTS_URL + query);
      audio.preload = 'auto';
      audio.playbackRate = 1.25;
      state.audios[index] = audio;
    }
    return state.audios[index];
  }

  async function playNextChunk(state) {
    if (playing !== state) return;
    if (state.index >= state.chunks.length) {
      stopPlayback();
      setStatus('朗读完成');
      return;
    }
    var part = state.index + 1;
    state.button.textContent = '…';
    state.button.title = '正在生成第 ' + part + ' 段语音';
    state.button.setAttribute('data-state', 'loading');
    setStatus('Edge TTS 正在生成第 ' + part + '/' + state.chunks.length + ' 段语音…');
    try {
      var audio = prepareSpeechChunk(state, state.index);
      if (playing !== state) return;
      state.audio = audio;
      audio.onended = function () {
        if (playing !== state) return;
        state.audio = null;
        state.index += 1;
        playNextChunk(state);
      };
      audio.onerror = function () {
        if (playing !== state) return;
        stopPlayback();
        setStatus('第 ' + part + ' 段音频播放失败', true);
      };
      await audio.play();
      if (playing !== state) return;
      state.button.textContent = '⏹';
      state.button.title = '停止朗读';
      state.button.setAttribute('data-state', 'playing');
      setStatus('正在朗读第 ' + part + '/' + state.chunks.length + ' 段');
      var nextAudio = prepareSpeechChunk(state, state.index + 1);
      if (nextAudio) nextAudio.load();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (playing === state) stopPlayback();
      setStatus('第 ' + part + ' 段朗读失败：' + (error && error.message ? error.message : error), true);
    }
  }

  function assistantText(node) {
    var clone = node.cloneNode(true);
    var ignored = clone.querySelectorAll(
      'button, pre, [data-dsh-edge-read], [data-variant], [data-json-expander], [data-json-copy-button]'
    );
    ignored.forEach(function (element) { element.remove(); });
    return core.normalizeReadableText(clone.textContent || '');
  }

  async function togglePlayback(node, button) {
    if (playing && playing.button === button) {
      stopPlayback();
      setStatus('已停止朗读');
      return;
    }
    stopPlayback();
    var text = assistantText(node);
    if (!text) {
      setStatus('这条回答没有可朗读文字', true);
      return;
    }

    playing = {
      button: button,
      audio: null,
      chunks: readableChunks(text, 200, 800),
      audios: [],
      index: 0
    };
    playNextChunk(playing);
  }

  function actionRow(node) {
    var actionContainers = node.querySelectorAll('[class*="actions"]');
    for (var containerIndex = actionContainers.length - 1; containerIndex >= 0; containerIndex -= 1) {
      if (actionContainers[containerIndex].querySelectorAll('button').length >= 2) {
        return actionContainers[containerIndex];
      }
    }
    var buttons = node.querySelectorAll('button[aria-label]');
    for (var index = 0; index < buttons.length; index += 1) {
      var label = buttons[index].getAttribute('aria-label') || '';
      if (/复制|Copy|好的回答|有问题的回答|Good response|Bad response/i.test(label)) {
        return buttons[index].parentElement;
      }
    }
    return null;
  }

  function precedingAssistantNode(tail) {
    var current = tail.previousElementSibling;
    while (current) {
      var kind = current.getAttribute && current.getAttribute('data-chat-flow-kind');
      if (kind === 'assistant-step') return current;
      if (kind === 'turn-tail') return null;
      current = current.previousElementSibling;
    }
    return null;
  }

  function appendReadButton(node, row, keyOwner) {
      if (!node || !row || row.querySelector('[data-dsh-edge-read]')) return;
      var key = keyOwner.getAttribute('data-dsh-message-key');
      if (!key) {
        messageCounter += 1;
        key = 'message-' + messageCounter;
        keyOwner.setAttribute('data-dsh-message-key', key);
      }
      var button = document.createElement('button');
      button.type = 'button';
      button.id = core.voiceButtonId(key);
      button.textContent = '🔊';
      button.title = '朗读这条回答';
      button.setAttribute('aria-label', '朗读这条回答');
      button.setAttribute('data-dsh-edge-read', '');
      button.setAttribute('data-state', 'idle');
      button.addEventListener('click', function () { togglePlayback(node, button); });
      row.appendChild(button);
  }

  function ensureReadButtons() {
    var tails = document.querySelectorAll('[data-chat-flow-kind="turn-tail"]');
    tails.forEach(function (tail) {
      appendReadButton(precedingAssistantNode(tail), actionRow(tail), tail);
    });

    var legacyNodes = document.querySelectorAll('[data-chat-flow-key="assistant-step"]');
    legacyNodes.forEach(function (node) {
      appendReadButton(node, actionRow(node), node);
    });
  }

  function reconcile() {
    reconcileQueued = false;
    ensureMicrophone();
    ensureReadButtons();
  }

  function queueReconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    setTimeout(reconcile, 0);
  }

  function boot() {
    reconcile();
    new MutationObserver(queueReconcile).observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
