// Room-noise reduction for steady sounds such as an air conditioner, fan, or fridge.
// A stretch with only that sound is measured once. Then, for the whole clip, the parts of
// the sound that match it are turned down, but never by more than the reduction limit,
// so quiet sounds that share those parts lose less level.

const N = 2048; // window length, about 43 ms at 48 kHz
const H = N / 4; // hop size, 75% overlap
const M = N / 2 + 1; // unique frequency bins
const OVER = 1.0; // how strongly the learned noise is subtracted
const WIN_SUM = 1.5; // a Hann window squared, summed at 75% overlap, equals 1.5

const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

const LOG2N = Math.log2(N);
const rev = new Uint32Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  rev[i] = r;
}
const cosT = new Float64Array(N / 2);
const sinT = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  cosT[i] = Math.cos((2 * Math.PI * i) / N);
  sinT[i] = Math.sin((2 * Math.PI * i) / N);
}

// In-place radix-2 FFT. The inverse divides by N, so forward then inverse returns the input.
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step];
        const wi = inverse ? sinT[k * step] : -sinT[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) {
      re[i] /= N;
      im[i] /= N;
    }
  }
}

// Light smoothing across neighboring bins. It steadies single bins and reduces musical noise.
function smooth(src: Float64Array, dst: Float64Array): void {
  for (let k = 0; k < M; k++) {
    const left = k > 0 ? src[k - 1] : src[k];
    const right = k < M - 1 ? src[k + 1] : src[k];
    dst[k] = 0.25 * left + 0.5 * src[k] + 0.25 * right;
  }
}

// Learns the steady sound between fromSec and toSec. Use a stretch with room noise and no voice.
export function learnNoiseProfile(
  channel: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number,
): Float64Array {
  const from = Math.max(0, Math.floor(fromSec * sampleRate));
  const to = Math.min(channel.length, Math.floor(toSec * sampleRate));
  if (to - from < sampleRate * 0.5) {
    throw new Error('The noise sample is too short. Pick at least half a second of room noise.');
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const sum = new Float64Array(M);
  let frames = 0;
  for (let start = from; start + N <= to; start += H) {
    for (let i = 0; i < N; i++) {
      re[i] = channel[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, false);
    for (let k = 0; k < M; k++) sum[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const mean = new Float64Array(M);
  for (let k = 0; k < M; k++) mean[k] = sum[k] / frames;
  const profile = new Float64Array(M);
  smooth(mean, profile);
  return profile;
}

// Lowers the learned noise in one channel. reductionDb is the most any part of the sound can drop.
// Returns a new array the same length as the input.
export async function reduceRoomNoise(
  channel: Float32Array,
  profile: Float64Array,
  reductionDb: number,
  onProgress?: (p: number) => void,
): Promise<Float32Array> {
  const len = channel.length;
  const out = new Float32Array(len);
  const floor2 = Math.pow(10, -reductionDb / 10); // lowest allowed power gain per bin
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const power = new Float64Array(M);
  const powerSmooth = new Float64Array(M);
  const totalFrames = Math.ceil((len + N - H) / H);
  let frame = 0;

  for (let start = -N + H; start < len; start += H) {
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      re[i] = (idx >= 0 && idx < len ? channel[idx] : 0) * win[i];
      im[i] = 0;
    }
    fft(re, im, false);
    for (let k = 0; k < M; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    smooth(power, powerSmooth);
    for (let k = 0; k < M; k++) {
      let g2 = 1 - (OVER * profile[k]) / Math.max(powerSmooth[k], 1e-20);
      if (g2 < floor2) g2 = floor2;
      const g = Math.sqrt(g2);
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < N / 2) {
        re[N - k] *= g;
        im[N - k] *= g;
      }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      if (idx >= 0 && idx < len) out[idx] += re[i] * win[i];
    }
    frame++;
    if (frame % 128 === 0) {
      onProgress?.(Math.min(1, frame / totalFrames));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  for (let i = 0; i < len; i++) out[i] /= WIN_SUM;
  onProgress?.(1);
  return out;
}
