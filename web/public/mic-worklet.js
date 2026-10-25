// mic-worklet.js — runs on the browser's audio thread: microphone samples (usually 48 kHz float) → 16 kHz 16-bit PCM
// in ~100 ms chunks, plus a loudness value. Downsampler is plain so the backend tests can run it in Node.

export class Downsampler {
  constructor(srcRate, dstRate = 16000) { this.ratio = srcRate / dstRate; this.acc = 0; this.n = 0; this.pos = 0; }
  /** @param {Float32Array} input  @returns {Int16Array} */
  push(input) {
    // box filter: each output sample is the mean of the input samples it covers (a crude low-pass, fine for speech)
    const out = new Int16Array(Math.ceil(input.length / this.ratio) + 1);
    let k = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        out[k++] = v < 0 ? v * 32768 : v * 32767;
        this.acc = 0; this.n = 0;
      }
    }
    return out.subarray(0, k);
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class MicPcm extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.down = new Downsampler(options.processorOptions?.srcRate ?? sampleRate);
      this.buf = new Int16Array(1600); // 100 ms at 16 kHz
      this.len = 0; this.sq = 0; this.cnt = 0;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      for (let i = 0; i < ch.length; i++) { this.sq += ch[i] * ch[i]; this.cnt++; }
      const pcm = this.down.push(ch);
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.len++] = pcm[i];
        if (this.len === this.buf.length) {
          const chunk = this.buf.slice(0).buffer;
          this.port.postMessage({ pcm: chunk, rms: Math.sqrt(this.sq / Math.max(1, this.cnt)) }, [chunk]);
          this.len = 0; this.sq = 0; this.cnt = 0;
        }
      }
      return true;
    }
  }
  registerProcessor('mic-pcm', MicPcm);
}
