// Noise reduction for voice (spectral gating). Pure JS, no DOM: unit-tested in tests/test_fx.mjs.
// The noise is learned from the pauses the cut removes (room hum, hiss, fan), then every 21 ms of the kept voice is
// split into frequencies; bands that are not clearly above that noise are turned down. Streams with a fixed delay and
// flush() returns the tail, so the output has exactly as many samples as went in (picture and sound stay in sync).

export const DENOISE = {
  off: null,
  low: { label: '약하게', over: 1.4, floorDb: -10 },
  mid: { label: '보통', over: 2.0, floorDb: -16 },
  high: { label: '강하게', over: 2.6, floorDb: -24 },
};

export function fftSize(sr) { let n = 256; while (n < sr * 0.021) n <<= 1; return n; }

// in-place radix-2 complex FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function ifft(re, im) { for (let i = 0; i < im.length; i++) im[i] = -im[i]; fft(re, im); const n = re.length; for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; } }
function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; }

// average power per frequency bin of a noise-only signal (mono). null when there is too little of it.
export function noiseProfile(samples, sr) {
  const N = fftSize(sr), H = N >> 1, win = hann(N); if (!samples || samples.length < N * 4) return null;
  const pow = new Float64Array(N / 2 + 1); let frames = 0; const re = new Float64Array(N), im = new Float64Array(N);
  for (let p = 0; p + N <= samples.length; p += H) {
    for (let i = 0; i < N; i++) { re[i] = samples[p + i] * win[i]; im[i] = 0; }
    fft(re, im); for (let k = 0; k <= N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k]; frames++;
  }
  for (let k = 0; k <= N / 2; k++) pow[k] /= frames;
  return { sr, N, pow };
}

// Streaming denoiser. push(chans) → output chans (possibly shorter or empty while it fills); flush() → the rest.
export class Denoiser {
  constructor(sr, channels, profile, strength = 'mid') {
    const p = DENOISE[strength] || DENOISE.mid; this.over = p.over; this.floor = Math.pow(10, p.floorDb / 20);
    this.N = fftSize(sr); this.H = this.N >> 2; this.win = hann(this.N); this.norm = 1 / 1.5; // Hann² at 75% overlap sums to 1.5
    this.noise = profile && profile.N === this.N ? profile.pow : new Float64Array(this.N / 2 + 1);
    this.ch = Array.from({ length: channels }, () => ({ inb: new Float32Array(this.N), out: new Float32Array(this.N), g: new Float32Array(this.N / 2 + 1).fill(1), p: new Float64Array(this.N / 2 + 1) }));
    this.fill = this.N - this.H; // the first frame starts with N-H zeros, so output sample 0 = input sample 0 after the delay
    this.pending = 0; this.pushed = 0; this.emitted = 0; this.lead = this.N - this.H;
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N); this.gain = new Float32Array(this.N / 2 + 1);
  }
  get delay() { return this.N - this.H; }
  _frame(c) {
    const { N, win, re, im, noise, over, floor, gain } = this; const st = this.ch[c];
    for (let i = 0; i < N; i++) { re[i] = st.inb[i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) {
      // power smoothed over time: per-band noise power jumps a lot frame to frame, raw values would let spikes through
      const P0 = re[k] * re[k] + im[k] * im[k]; const P = (st.p[k] = st.p[k] * 0.6 + P0 * 0.4) + 1e-20; let g = Math.sqrt(Math.max(0, 1 - over * noise[k] / P)); if (g < floor) g = floor;
      const prev = st.g[k]; g = g >= prev ? g : prev * 0.65 + g * 0.35; st.g[k] = g; gain[k] = g; // fast open, slower close: less "musical" noise
    }
    for (let k = 0; k <= N / 2; k++) { const g = (gain[Math.max(0, k - 1)] + 2 * gain[k] + gain[Math.min(N / 2, k + 1)]) / 4; re[k] *= g; im[k] *= g; if (k && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
    ifft(re, im);
    const out = st.out; for (let i = 0; i < N; i++) out[i] += re[i] * win[i] * this.norm;
  }
  // feed samples through the STFT; returns the raw overlap-added output (starts with `delay` samples of lead-in)
  _feed(chans, len) {
    const { N, H } = this; const outs = this.ch.map(() => []); let i = 0;
    while (i < len) {
      const take = Math.min(H - this.pending, len - i);
      for (let c = 0; c < this.ch.length; c++) { const src = chans[c] || chans[0]; this.ch[c].inb.set(src.subarray(i, i + take), this.fill + this.pending); }
      this.pending += take; i += take;
      if (this.pending === H) {
        for (let c = 0; c < this.ch.length; c++) {
          const st = this.ch[c]; this._frame(c);
          outs[c].push(st.out.slice(0, H)); st.out.copyWithin(0, H); st.out.fill(0, N - H); st.inb.copyWithin(0, H); st.inb.fill(0, N - H);
        }
        this.pending = 0;
      }
    }
    return outs.map(cat);
  }
  // drop the lead-in and never hand out more samples than were pushed
  _emit(raw) {
    let out = raw; if (this.lead > 0) { const cut = Math.min(this.lead, out[0].length); out = out.map(o => o.subarray(cut)); this.lead -= cut; }
    const room = this.pushed - this.emitted; if (out[0].length > room) out = out.map(o => o.subarray(0, room));
    this.emitted += out[0].length; return out;
  }
  push(chans) { const len = chans[0].length; this.pushed += len; return this._emit(this._feed(chans, len)); }
  flush() {
    const parts = this.ch.map(() => []); const zeros = this.ch.map(() => new Float32Array(this.H));
    for (let guard = 0; this.emitted < this.pushed && guard < 64; guard++) this._emit(this._feed(zeros, this.H)).forEach((o, c) => parts[c].push(o));
    return parts.map(cat);
  }
}
function cat(parts) { const total = parts.reduce((a, p) => a + p.length, 0); const o = new Float32Array(total); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
