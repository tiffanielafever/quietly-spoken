import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';

type Demo = { ctx: AudioContext; dry: GainNode; wet: GainNode; stops: Array<() => void> };

// Synthesized demo: hiss plus 60/120/180 Hz hum. "Cleaned" runs the same signal through three notches and a 75 Hz highpass.
function startDemo(cleaned: boolean): Demo {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = cleaned ? 0 : 1;
  wet.gain.value = cleaned ? 1 : 0;
  dry.connect(master);
  wet.connect(master);

  const sum = ctx.createGain();
  sum.gain.value = 0.2;
  sum.connect(dry);
  let last: AudioNode = sum;
  for (const f of [60, 120, 180]) {
    const notch = ctx.createBiquadFilter();
    notch.type = 'notch';
    notch.frequency.value = f;
    notch.Q.value = 35;
    last.connect(notch);
    last = notch;
  }
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 75;
  last.connect(hp);
  hp.connect(wet);

  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  const hiss = ctx.createBufferSource();
  hiss.buffer = buf;
  hiss.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4000;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.15;
  hiss.connect(lp);
  lp.connect(hissGain);
  hissGain.connect(sum);

  const hum = [60, 120, 180].map((f, i) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = f;
    g.gain.value = 0.1 / (i + 1);
    osc.connect(g);
    g.connect(sum);
    return osc;
  });
  hiss.start();
  hum.forEach((o) => o.start());
  return { ctx, dry, wet, stops: [() => hiss.stop(), ...hum.map((o) => () => o.stop())] };
}

function stopDemo(ref: { current: Demo | null }) {
  const d = ref.current;
  if (!d) return;
  d.stops.forEach((s) => s());
  void d.ctx.close();
  ref.current = null;
}

function HeadphoneConsole() {
  const [on, setOn] = useState(false);
  const [cleaned, setCleaned] = useState(true);
  const demo = useRef<Demo | null>(null);

  useEffect(() => {
    const d = demo.current;
    if (!d) return;
    const t = d.ctx.currentTime;
    d.dry.gain.setTargetAtTime(cleaned ? 0 : 1, t, 0.02);
    d.wet.gain.setTargetAtTime(cleaned ? 1 : 0, t, 0.02);
  }, [cleaned]);

  useEffect(() => () => stopDemo(demo), []);

  const toggle = () => {
    if (on) {
      stopDemo(demo);
      setOn(false);
    } else {
      demo.current = startDemo(cleaned);
      setOn(true);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-card p-6">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={toggle} className="rounded-xl bg-amber px-4 py-2 font-semibold text-[#1a140d]">
          {on ? 'Take Them Off' : 'Put On Headphones'}
        </button>
        <button
          type="button"
          disabled={!on}
          onClick={() => setCleaned((c) => !c)}
          className="rounded-xl border border-sage px-4 py-2 text-sage disabled:opacity-40"
        >
          {cleaned ? 'Now: cleaned' : 'Now: original'}
        </button>
      </div>
      <p className="mt-4 text-sm text-stone">
        Hum and hiss are synthesized in your browser. Sound starts only when you press the button.
      </p>
      <p className="mt-2 text-xs text-stone">
        A simplified demo with synthesized hiss and hum at 60, 120, and 180 Hz. The app itself uses four notches, including 240 Hz, and works on real recordings.
      </p>
    </div>
  );
}

const PAIN = [
  ['Fridge hum under every whisper', 'Narrow notches target the 60 Hz hum and its harmonics, and leave most of the voice untouched.'],
  ['Mouth clicks that jump the meter', 'Repairs run up to 3 ms long. The detector listens between 1.2 and 4.5 kHz, where wet clicks live.'],
  ['Hiss in the quiet parts', 'One stereo-linked expander moves both ears together, so the image does not wobble.'],
] as const;

const FLOW = [
  ['Video', 'Stream copied bit for bit. Never re-encoded.'],
  ['Audio', 'Video exports keep your picture and replace the sound with cleaned AAC at 320 kbps. WAV exports are uncompressed 16-bit stereo.'],
  ['Files', 'Decoded and processed locally. Nothing is uploaded.'],
] as const;

// Placeholder tiers: replace names, prices, and notes with the final plan before launch.
const PRICING = [
  { name: 'Preview', price: '$0', note: '15-second preview windows and WAV export' },
  { name: 'Creator', price: '$12 / mo', note: 'Full-track WAV and clean MP4 export' },
  { name: 'Studio', price: '$29 / mo', note: 'Everything in Creator, for long-form projects' },
] as const;

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 pb-24">
      <header className="flex items-center justify-between py-6">
        <span className="font-serif text-xl">{BRAND.name}</span>
        <Link to="/studio" className="text-sm text-amber">Open the studio</Link>
      </header>

      <section className="mt-10 grid gap-10 md:grid-cols-2 md:items-center">
        <div>
          <p className="font-mono text-xs text-sage">ASMR restoration, local only</p>
          <h1 className="mt-4 font-serif text-5xl leading-[1.05]">Whispers that stay close. Hum that stays gone.</h1>
          <p className="mt-5 max-w-prose text-stone">
            Remove fridge hum, mouth clicks, and room hiss from audio and camera video, entirely in your browser.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/studio" className="rounded-xl bg-amber px-5 py-3 font-semibold text-[#1a140d]">Open the studio</Link>
          </div>
        </div>
        <HeadphoneConsole />
      </section>

      <section className="mt-20 grid gap-4 md:grid-cols-3">
        {PAIN.map(([title, body]) => (
          <article key={title} className="rounded-2xl border border-line bg-card p-6">
            <h2 className="font-serif text-xl">{title}</h2>
            <p className="mt-3 text-sm text-stone">{body}</p>
          </article>
        ))}
      </section>

      <section className="mt-20">
        <h2 className="font-serif text-3xl">What happens to your file</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {FLOW.map(([k, v]) => (
            <div key={k} className="grid gap-2 py-4 md:grid-cols-[120px_1fr]">
              <dt className="font-mono text-sm text-sage">{k}</dt>
              <dd className="text-stone">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-20 max-w-2xl">
        <h2 className="font-serif text-3xl">A note from us</h2>
        <p className="mt-4 text-stone">
          Quietly Spoken exists so a quiet recording stays quiet. Clean the hum, the clicks, and the hiss, keep the room,
          and keep the file on your own machine.
        </p>
        <p className="mt-4 font-mono text-sm">{BRAND.signoff}</p>
      </section>

      <section className="mt-20">
        <h2 className="font-serif text-3xl">Pricing</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {PRICING.map((t) => (
            <div key={t.name} className="rounded-2xl border border-line bg-card p-6">
              <h3 className="font-serif text-xl">{t.name}</h3>
              <p className="mt-2 font-mono text-2xl text-amber">{t.price}</p>
              <p className="mt-3 text-sm text-stone">{t.note}</p>
              <Link to="/studio" className="mt-5 inline-block text-sm text-amber">Start in the studio</Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
