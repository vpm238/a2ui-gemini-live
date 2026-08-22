/**
 * Microphone in at 16 kHz, model out at 24 kHz, and the ability to stop
 * mid-sentence.
 *
 * The last one is the point. In the Deepgram build this repo grew out of,
 * "interrupting" meant tapping a card to cancel a `SpeechSynthesisUtterance`
 * — a local trick that looked like barge-in. Here the model genuinely stops:
 * it hears the user start, abandons its turn, and sends `interrupted`. What
 * this file has to do is make the *speaker* agree, immediately, because a
 * couple of seconds of already-queued audio will otherwise keep playing over
 * the person who just cut in. Hence Player.stop() killing live sources rather
 * than merely stopping the queue.
 *
 * Both directions are raw little-endian PCM16. No containers, no codecs.
 */

export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;

/**
 * A tiny worklet: hand every render quantum straight to the main thread.
 * Shipped as a Blob so the demo stays a static file tree with no fetches.
 */
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class Microphone {
  #ctx = null;
  #stream = null;
  #node = null;
  #source = null;

  /** @param {(pcm: Int16Array, level: number) => void} onChunk */
  constructor(onChunk) { this.onChunk = onChunk; }

  async start() {
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // without this the model hears itself and interrupts itself
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    // Chrome honours sampleRate here and resamples the stream for us. Safari
    // ignores it, so #convert resamples whatever we actually got.
    this.#ctx = new AudioContext({ sampleRate: INPUT_RATE });
    await this.#ctx.resume();
    await this.#ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })),
    );

    this.#source = this.#ctx.createMediaStreamSource(this.#stream);
    this.#node = new AudioWorkletNode(this.#ctx, 'tap');
    this.#node.port.onmessage = ({ data }) => {
      const pcm = this.#convert(data);
      this.onChunk?.(pcm, rms(data));
    };
    this.#source.connect(this.#node);
    // A worklet with no destination is culled by some implementations; a
    // muted gain node keeps the graph alive without any audible output.
    const mute = this.#ctx.createGain();
    mute.gain.value = 0;
    this.#node.connect(mute).connect(this.#ctx.destination);

    return { sampleRate: this.#ctx.sampleRate };
  }

  #convert(float32) {
    const ratio = this.#ctx.sampleRate / INPUT_RATE;
    const length = Math.round(float32.length / ratio);
    const out = new Int16Array(length);
    for (let i = 0; i < length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32[Math.round(i * ratio)] ?? 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  stop() {
    this.#node?.disconnect();
    this.#source?.disconnect();
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#ctx?.close().catch(() => {});
    this.#ctx = this.#stream = this.#node = this.#source = null;
  }

  get running() { return Boolean(this.#ctx); }
}

/**
 * Gapless playback of a stream of PCM chunks, with a real stop.
 *
 * Chunks arrive faster than real time, so each one is scheduled at the end of
 * the last rather than at "now" — otherwise they overlap into noise.
 */
export class Player {
  #ctx = null;
  #cursor = 0;
  #live = new Set();

  constructor({ onStateChange } = {}) { this.onStateChange = onStateChange; }

  /** Must be called from a user gesture, or the context stays suspended. */
  async prime() {
    this.#ctx ??= new AudioContext({ sampleRate: OUTPUT_RATE });
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();
    return this.#ctx.state;
  }

  /** @param {string} base64  PCM16 @ 24 kHz */
  async play(base64) {
    await this.prime();
    const pcm = decodeBase64ToInt16(base64);
    if (!pcm.length) return;

    const buffer = this.#ctx.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;

    const source = this.#ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#ctx.destination);

    const now = this.#ctx.currentTime;
    // A little slack so a late chunk doesn't get scheduled in the past.
    const startAt = Math.max(now + 0.02, this.#cursor);
    source.start(startAt);
    this.#cursor = startAt + buffer.duration;

    this.#live.add(source);
    const wasIdle = this.#live.size === 1;
    if (wasIdle) this.onStateChange?.('speaking');
    source.onended = () => {
      this.#live.delete(source);
      if (!this.#live.size) this.onStateChange?.('idle');
    };
  }

  /** Barge-in: kill what is playing and everything already scheduled. */
  stop() {
    for (const source of this.#live) {
      try { source.stop(); } catch { /* already finished */ }
    }
    this.#live.clear();
    this.#cursor = this.#ctx ? this.#ctx.currentTime : 0;
    this.onStateChange?.('idle');
  }

  /** Seconds of audio still queued ahead of now. */
  get pending() {
    if (!this.#ctx) return 0;
    return Math.max(0, this.#cursor - this.#ctx.currentTime);
  }

  close() {
    this.stop();
    this.#ctx?.close().catch(() => {});
    this.#ctx = null;
  }
}

function decodeBase64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Copy through a fresh buffer: the byte offset is not guaranteed to be
  // 2-aligned, and Int16Array insists on alignment.
  return new Int16Array(bytes.buffer.slice(0, bytes.length - (bytes.length % 2)));
}

function rms(float32) {
  let sum = 0;
  for (const v of float32) sum += v * v;
  return Math.sqrt(sum / float32.length);
}
