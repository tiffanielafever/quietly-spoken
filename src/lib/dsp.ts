// Quietly Spoken V3 chain at its default settings: hum notch 60 Hz with harmonics, stereo-linked room expander,
// vocal-focus click repair, stereo-linked de-ess, -1.0 dBFS limiter. Streaming: output sample nd is emitted
// LA samples after input nd, so the click repair can look ahead without buffering the whole track.

export type Pair = [Float32Array, Float32Array];
type Bq = (x: number) => number;

const CEIL = Math.pow(10, -1 / 20);
const clamp = (x: number) => Math.max(-CEIL, Math.min(CEIL, x));

function biquad(t: 'notch' | 'hp' | 'bp', f: number, q: number, sr: number): Bq {
  const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const [b0, b1, b2] = t === 'notch' ? [1, -2 * c, 1] : t === 'hp' ? [(1 + c) / 2, -1 - c, (1 + c) / 2] : [al, 0, -al];
  const k0 = b0 / a0, k1 = b1 / a0, k2 = b2 / a0, k3 = (-2 * c) / a0, k4 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = k0 * x + k1 * x1 + k2 * x2 - k3 * y1 - k4 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

// 5th-percentile room tone: 250 ms frames, digital silence dropped, bottom 5% averaged
export function noiseFloor([L, R]: Pair, sr: number): number {
  const fl = Math.max(1, Math.round(0.25 * sr)), e: number[] = [];
  for (let s = 0; s + fl <= L.length; s += fl) {
    let a = 0;
    for (let i = s; i < s + fl; i++) a += L[i] * L[i] + R[i] * R[i];
    const ms = a / (2 * fl);
    if (10 * Math.log10(ms + 1e-30) > -90) e.push(ms);
  }
  if (!e.length) return 1e-5;
  e.sort((x, y) => x - y);
  const k = Math.max(1, Math.floor(e.length * 0.05));
  return Math.sqrt(e.slice(0, k).reduce((x, y) => x + y, 0) / k);
}

interface Ch { rg: Float32Array; pb: Float32Array; hn: Bq[]; hp: Bq; dt: Bq; bd: Bq; sk: number; ms: number }

function makeChain(src: Pair, sr: number, floor: number) {
  const n = src[0].length, M = Math.max(2, Math.round(0.003 * sr)), LA = M + 2, K = 4095;
  const thr = Math.max(floor, 1e-5) * 1.6, ct = 16 - 12 * 0.6, maxDb = 15;
  const kE = Math.exp(-1 / (0.01 * sr)), kA = Math.exp(-1 / (0.015 * sr)), kR = Math.exp(-1 / (0.18 * sr));
  const kD = Math.exp(-1 / (0.005 * sr)), kEnv = Math.exp(-1 / (0.002 * sr)), kRel = Math.exp(-1 / (0.06 * sr));
  const kAvg = Math.exp(-1 / (2 * sr)), kLA = Math.exp(-1 / (0.0005 * sr)), kLR = Math.exp(-1 / (0.08 * sr));
  const mk = (): Ch => ({
    rg: new Float32Array(K + 1),
    pb: new Float32Array(K + 1),
    hn: [60, 120, 180, 240].map((f) => biquad('notch', f, 35, sr)),
    hp: biquad('hp', 75, 0.707, sr),
    dt: biquad('bp', 2370, 0.72, sr),
    bd: biquad('bp', 6840, 2.3, sr),
    sk: -1,
    ms: 0,
  });
  const C: [Ch, Ch] = [mk(), mk()];
  let ip = 0, e2 = 0, g = 1, env = 0, avg = 0, lg = 1;

  const hum = (c: Ch, x: number) => {
    const y = c.hn[0](x), a = c.hn[3](c.hn[2](c.hn[1](y)));
    return y + 0.6 * (a - y);
  };

  // Stage 1: hum notch, then the stereo-linked room expander (one sidechain, one gain for both channels)
  const s1 = (i: number) => {
    let r0 = C[0].hp(hum(C[0], src[0][i])), r1 = C[1].hp(hum(C[1], src[1][i]));
    const sc = Math.max(Math.abs(r0), Math.abs(r1));
    e2 = kE * e2 + (1 - kE) * sc * sc;
    const l = Math.sqrt(e2) + 1e-9;
    const t = l < thr ? Math.pow(10, -Math.min(maxDb, 50 * Math.log10(thr / l)) / 20) : 1;
    g = t > g ? kA * g + (1 - kA) * t : kR * g + (1 - kR) * t;
    r0 *= g; r1 *= g;
    const j = i & K;
    C[0].rg[j] = r0; C[0].pb[j] = C[0].dt(r0);
    C[1].rg[j] = r1; C[1].pb[j] = C[1].dt(r1);
  };

  // Stage 2: 3 ms transient repair, detected on the 1.2 to 4.5 kHz band
  const s2 = (c: Ch, nd: number) => {
    if (nd > c.sk && nd + M + 2 < n) {
      const pb = c.pb, dl = pb[nd & K] - pb[(nd - 1) & K], r = ct * (Math.sqrt(c.ms) + 1e-6);
      if (Math.abs(dl) > r && Math.abs(dl) > 0.03) {
        let e = nd;
        while (e - nd < M && Math.abs(pb[(e + 1) & K] - pb[e & K]) > r) e++;
        const a = c.rg[(nd - 1) & K], b = c.rg[(e + 1) & K];
        for (let j = nd; j <= e; j++) c.rg[j & K] = a + ((b - a) * (j - nd + 1)) / (e - nd + 2);
        c.sk = e + 1;
      } else c.ms = kD * c.ms + (1 - kD) * dl * dl;
    }
    return c.rg[nd & K];
  };

  return (i0: number, i1: number, sink: (k: number, a: number, b: number) => void) => {
    for (let nd = i0, end = Math.min(i1, n); nd < end; nd++) {
      const lim = Math.min(n - 1, nd + LA);
      while (ip <= lim) s1(ip++);
      let o0 = s2(C[0], nd), o1 = s2(C[1], nd);
      // Stage 3: stereo-linked de-ess on the 5.5 to 8.5 kHz band
      const b0 = C[0].bd(o0), b1 = C[1].bd(o1), sc = Math.max(Math.abs(b0), Math.abs(b1));
      env = sc > env ? kEnv * env + (1 - kEnv) * sc : kRel * env + (1 - kRel) * sc;
      avg = kAvg * avg + (1 - kAvg) * sc * sc;
      const th = 1.2 * Math.sqrt(avg) + 1e-9;
      const cut = env > th ? Math.min(0.9, (0.5 * (env - th)) / env) * Math.min(1, nd / (2 * sr)) : 0;
      o0 -= b0 * cut; o1 -= b1 * cut;
      // Stage 4: stereo-linked limiter at -1.0 dBFS with a hard clamp behind it
      const pk = Math.max(Math.abs(o0), Math.abs(o1)), gt = pk > CEIL ? CEIL / pk : 1;
      lg = gt < lg ? kLA * lg + (1 - kLA) * gt : kLR * lg + (1 - kLR) * gt;
      sink(nd, clamp(o0 * lg), clamp(o1 * lg));
    }
  };
}

const put16 = (dv: DataView, o: number, x: number) => {
  const v = clamp(x);
  dv.setInt16(o, Math.round(v * (v < 0 ? 32768 : 32767)), true);
  return o + 2;
};

function wavHeader(n: number, sr: number): ArrayBuffer {
  const len = n * 4, ab = new ArrayBuffer(44), dv = new DataView(ab);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + len, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, len, true);
  return ab;
}

// Full-track render in chunks, yielding to the UI between chunks. Returns a 16-bit stereo WAV.
export async function renderCleanWav(src: Pair, sr: number, onProgress: (p: number) => void): Promise<Blob> {
  const n = src[0].length, floor = noiseFloor(src, sr), CH = 1 << 18;
  const run = makeChain(src, sr, floor);
  const parts: ArrayBuffer[] = [wavHeader(n, sr)];
  for (let i0 = 0; i0 < n; i0 += CH) {
    const i1 = Math.min(n, i0 + CH), ab = new ArrayBuffer((i1 - i0) * 4), dv = new DataView(ab);
    let o = 0;
    run(i0, i1, (_k, a, b) => { o = put16(dv, o, a); o = put16(dv, o, b); });
    parts.push(ab);
    onProgress(i1 / n);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Blob(parts, { type: 'audio/wav' });
}
