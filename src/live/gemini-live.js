/**
 * Gemini Live, over the raw WebSocket.
 *
 * No SDK. The SDK is fine, but this repo's whole argument is about what
 * crosses the wire and when — so the wire is worth being able to read. The
 * protocol is small enough that hiding it would cost more than it saves.
 *
 * WHAT IS LOAD-BEARING HERE
 *
 * `responseModalities` accepts exactly one value, and every model that serves
 * bidiGenerateContent today is native-audio, which means the only legal value
 * is AUDIO. You cannot ask for text and audio together. So "talk and emit
 * A2UI at the same time" is not two response modalities — it is one audio
 * stream plus a function call, and the function call is the A2UI.
 *
 * Both tools are declared *blocking* (no `behavior: NON_BLOCKING`). That is
 * the only reason the modality gates have anywhere to stand: the model waits
 * for the tool result, so the renderer gets to brief it on what is on screen
 * before it says the next sentence. See src/render/gates.js.
 *
 * Audio is raw little-endian 16-bit PCM: 16 kHz going up, 24 kHz coming down.
 */

import { systemInstruction, functionDeclarations } from '../express/prompt.js';

export const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Verified available for bidiGenerateContent; the first is the default. */
export const LIVE_MODELS = [
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-latest',
  'models/gemini-2.5-flash-native-audio-preview-12-2025',
];

export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;

export class GeminiLive {
  #ws = null;
  #listeners = new Map();
  #ready = null;

  /**
   * @param {object} options
   * @param {string} [options.apiKey]  a long-lived API key. Local use only.
   * @param {string} [options.token]   an ephemeral token from /api/gemini-token. Preferred.
   * @param {object} options.catalog
   * @param {import('../session.js').Session} options.session  handles the tool calls
   * @param {string} [options.model]
   * @param {string} [options.voice]     prebuilt voice name, e.g. 'Puck'
   * @param {typeof WebSocket} [options.WebSocketImpl]  for Node
   * @param {object} [options.socketOptions]            for Node (proxy agent)
   */
  constructor({
    apiKey, token, catalog, session,
    model = LIVE_MODELS[0],
    voice = null,
    WebSocketImpl = globalThis.WebSocket,
    socketOptions = undefined,
  }) {
    if (!apiKey && !token) throw new Error('GeminiLive needs an apiKey or a token');
    if (!catalog) throw new Error('GeminiLive needs a catalog');
    if (!session) throw new Error('GeminiLive needs a Session to answer tool calls');
    if (!WebSocketImpl) throw new Error('no WebSocket available — pass WebSocketImpl');

    Object.assign(this, { apiKey, token, catalog, session, model, voice, WebSocketImpl, socketOptions });
  }

  /**
   * Ephemeral tokens and API keys travel in DIFFERENT query parameters, and
   * mixing them up costs an hour: an `AQ.…` token passed as `key` fails with
   * "Method doesn't allow unregistered callers", which reads like a revoked
   * credential rather than a misnamed parameter.
   */
  get credential() {
    return this.token
      ? `access_token=${encodeURIComponent(this.token)}`
      : `key=${encodeURIComponent(this.apiKey)}`;
  }

  on(event, fn) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn]);
    return this;
  }

  #emit(event, payload) {
    for (const fn of this.#listeners.get(event) ?? []) {
      try { fn(payload); } catch (err) { console.error(`listener for "${event}" threw`, err); }
    }
  }

  /** Resolves once the server has acknowledged setup. Rejects if it refuses. */
  connect({ timeoutMs = 15000 } = {}) {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise((resolve, reject) => {
      // The credential rides in the query string because browsers cannot set
      // headers on a WebSocket handshake. Deployed, it should be a short-lived
      // token minted server-side — see functions/api/gemini-token.js.
      const url = `${LIVE_URL}?${this.credential}`;
      const ws = this.socketOptions
        ? new this.WebSocketImpl(url, this.socketOptions)
        : new this.WebSocketImpl(url);
      ws.binaryType = 'arraybuffer';
      this.#ws = ws;

      const timer = setTimeout(() => {
        reject(new Error(`Gemini Live did not complete setup within ${timeoutMs}ms`));
        this.close();
      }, timeoutMs);

      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

      ws.onopen = () => {
        this.#emit('open');
        this.#send({
          setup: {
            model: this.model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              ...(this.voice && {
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
              }),
            },
            systemInstruction: { parts: [{ text: systemInstruction(this.catalog) }] },
            tools: functionDeclarations(this.catalog),
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        });
      };

      ws.onmessage = async (event) => {
        const msg = await parseFrame(event.data);
        if (!msg) return;
        if (msg.setupComplete) { this.#emit('setup', msg.setupComplete); settle(resolve); return; }
        this.#dispatch(msg);
      };

      ws.onerror = () => {
        // Browsers deliberately withhold the reason; `close` carries it.
        this.#emit('error', new Error('WebSocket error'));
      };

      ws.onclose = (event) => {
        const reason = event?.reason || '';
        this.#emit('close', { code: event?.code, reason });
        settle(reject, new Error(
          reason
            ? `Gemini Live closed the connection: ${reason}`
            : `Gemini Live closed the connection (code ${event?.code ?? '?'})`,
        ));
        this.#ready = null;
      };
    });

    return this.#ready;
  }

  #dispatch(msg) {
    const content = msg.serverContent;
    if (content) {
      // Barge-in. The model heard the user start talking and abandoned its
      // turn; anything already queued for playback is now stale.
      if (content.interrupted) this.#emit('interrupted');
      if (content.inputTranscription?.text) this.#emit('heard', content.inputTranscription.text);
      if (content.outputTranscription?.text) this.#emit('said', content.outputTranscription.text);

      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          this.#emit('audio', { base64: part.inlineData.data, mimeType: part.inlineData.mimeType });
        }
        if (part.text) this.#emit('text', part.text);
      }
      if (content.turnComplete) this.#emit('turnComplete');
    }

    if (msg.toolCall) this.#handleToolCall(msg.toolCall);
    if (msg.toolCallCancellation) this.#emit('toolCancelled', msg.toolCallCancellation);
    if (msg.goAway) this.#emit('goAway', msg.goAway);
    if (msg.usageMetadata) this.#emit('usage', msg.usageMetadata);
  }

  #handleToolCall(toolCall) {
    const functionResponses = [];
    for (const call of toolCall.functionCalls ?? []) {
      const response = this.session.call(call.name, call.args ?? {});
      this.#emit('tool', { name: call.name, args: call.args ?? {}, response });
      functionResponses.push({ id: call.id, name: call.name, response });
    }
    if (functionResponses.length) this.#send({ toolResponse: { functionResponses } });
  }

  /**
   * One chunk of microphone audio.
   * @param {Int16Array|ArrayBuffer|string} chunk  PCM16 @16kHz, or base64 of it
   */
  sendAudio(chunk) {
    const data = typeof chunk === 'string' ? chunk : toBase64(chunk);
    this.#send({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${INPUT_RATE}` } } });
  }

  /** Type instead of talking. Same turn semantics as speaking. */
  sendText(text) {
    this.#send({ realtimeInput: { text } });
  }

  /** Tell the model something happened that it did not hear — e.g. a tap. */
  sendSystemNote(text) {
    this.#send({ realtimeInput: { text } });
  }

  /** The microphone stopped; let the model take its turn. */
  endAudio() {
    this.#send({ realtimeInput: { audioStreamEnd: true } });
  }

  #send(payload) {
    if (this.#ws?.readyState !== 1) return false;
    this.#ws.send(JSON.stringify(payload));
    return true;
  }

  get connected() { return this.#ws?.readyState === 1; }

  close() {
    try { this.#ws?.close(); } catch { /* already gone */ }
    this.#ws = null;
    this.#ready = null;
  }
}

/** Frames arrive as string, Blob or ArrayBuffer depending on the runtime. */
async function parseFrame(data) {
  let text;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (typeof Blob !== 'undefined' && data instanceof Blob) text = await data.text();
  else text = String(data);

  try { return JSON.parse(text); } catch { return null; }
}

function toBase64(chunk) {
  const bytes = chunk instanceof ArrayBuffer
    ? new Uint8Array(chunk)
    : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');

  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode has an argument-count limit.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
