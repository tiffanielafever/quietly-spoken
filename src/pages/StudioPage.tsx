import SubscribeButton from '../components/SubscribeButton';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';
import { renderCleanWav } from '../lib/dsp';
import { extractAudioWav, remuxCleanMp4 } from '../lib/ffmpegRemux';
import { learnNoiseProfile, reduceRoomNoise } from '../lib/roomNoise';

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
// Free-tier preview limit. Set FREE_TIER to false to test full exports.
const FREE_TIER = true;
const FREE_PREVIEW_S = 30;

// Keeps only the first seconds of a buffer for the free tier.
function clipForTier(buf: AudioBuffer): AudioBuffer {
  if (!FREE_TIER) return buf;
  const frames = Math.min(buf.length, Math.round(FREE_PREVIEW_S * buf.sampleRate));
  if (frames === buf.length) return buf;
  const ctx = new OfflineAudioContext(buf.numberOfChannels, frames, buf.sampleRate);
  const out = ctx.createBuffer(buf.numberOfChannels, frames, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(0, frames));
  }
  return out;
}
// Native decode first. FFmpeg extracts the audio track only when the browser cannot read the container.
async function decodeAudio(file: File): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    try {
      return await ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      const wav = await extractAudioWav(file);
      return await ctx.decodeAudioData(await wav.arrayBuffer());
    }
  } finally {
    void ctx.close();
  }
}

// Peak and RMS of a whole buffer, used to level-match the cleaned track to the original.
function stats(buf: AudioBuffer): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      sum += x * x;
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
    }
    n += d.length;
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, peak };
}

// Gain for the cleaned track so its loudness matches the original, without clipping.
function matchGain(orig: AudioBuffer | undefined, clean: AudioBuffer | undefined): number {
  if (!orig || !clean) return 1;
  const o = stats(orig);
  const c = stats(clean);
  if (o.rms === 0 || c.rms === 0 || c.peak === 0) return 1;
  const maxForPeak = 0.98 / c.peak;
  return Math.min(2, o.rms / c.rms, maxForPeak);
}

const button = 'rounded-xl border border-line bg-card px-3 py-2 text-sm text-paper hover:border-stone';
const activeButton = 'rounded-xl border border-amber bg-amber px-3 py-2 text-sm font-semibold text-[#1a140d]';

type Mode = 'original' | 'cleaned';
type Track = 'orig' | 'clean';
type Voice = { src: AudioBufferSourceNode; env: GainNode };
type Profile = { left: Float64Array; right: Float64Array };

export default function StudioPage() {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [cleanReady, setCleanReady] = useState(false);
  const [mode, setMode] = useState<Mode>('cleaned');
  const [showVideo, setShowVideo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Choose a camera video (.mp4 or .mov) to begin.');
  const [noiseFrom, setNoiseFrom] = useState('0');
  const [noiseTo, setNoiseTo] = useState('3');
  const [noiseLearned, setNoiseLearned] = useState(false);
  const [reductionDb, setReductionDb] = useState(10);

  const videoRef = useRef<HTMLVideoElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Partial<Record<Track, AudioBuffer>>>({});
  const trackGainsRef = useRef<Partial<Record<Track, GainNode>>>({});
  const matchGainRef = useRef(1);
  const modeRef = useRef<Mode>('cleaned');
  const voicesRef = useRef<Voice[]>([]);
  const startRef = useRef({ ctxTime: 0, mediaTime: 0, rate: 1 });
  const driftTimerRef = useRef<number | null>(null);
  const profileRef = useRef<Profile | null>(null);

  const getCtx = () => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume();
    return ctxRef.current;
  };

  // Creates the two track gains once. Each track goes to the speakers through its own gain,
  // which is what the Original/Cleaned switch changes.
  const ensureGains = (ctx: AudioContext) => {
    const g = trackGainsRef.current;
    const isCleaned = modeRef.current === 'cleaned';
    if (!g.orig) {
      const o = ctx.createGain();
      o.gain.value = isCleaned ? 0 : 1;
      o.connect(ctx.destination);
      g.orig = o;
    }
    if (!g.clean) {
      const c = ctx.createGain();
      c.gain.value = isCleaned ? matchGainRef.current : 0;
      c.connect(ctx.destination);
      g.clean = c;
    }
  };

  // Fades between tracks. No seek, so no click.
  const applyMode = (next: Mode) => {
    modeRef.current = next;
    setMode(next);
    const ctx = ctxRef.current;
    const g = trackGainsRef.current;
    if (!ctx || !g.orig || !g.clean) return;
    const now = ctx.currentTime;
    g.orig.gain.setTargetAtTime(next === 'original' ? 1 : 0, now, 0.01);
    g.clean.gain.setTargetAtTime(next === 'cleaned' ? matchGainRef.current : 0, now, 0.01);
  };

  // Fades out and stops every playing source. Used on pause, seek, and restart.
  const stopVoices = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of voicesRef.current) {
      try {
        v.env.gain.cancelScheduledValues(now);
        v.env.gain.setValueAtTime(v.env.gain.value, now);
        v.env.gain.linearRampToValueAtTime(0, now + 0.02);
        v.src.stop(now + 0.03);
      } catch {
        // Already stopped
      }
    }
    voicesRef.current = [];
  };

  // Starts both tracks from the same media position, each with a short fade-in.
  const startVoices = (offset: number, rate: number) => {
    const ctx = getCtx();
    ensureGains(ctx);
    stopVoices();
    const now = ctx.currentTime;
    (['orig', 'clean'] as Track[]).forEach((track) => {
      const buf = buffersRef.current[track];
      const out = trackGainsRef.current[track];
      if (!buf || !out) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(1, now + 0.02);
      src.connect(env);
      env.connect(out);
      const safeOffset = Math.max(0, Math.min(offset, buf.duration - 0.01));
      src.start(now, safeOffset);
      voicesRef.current.push({ src, env });
    });
    startRef.current = { ctxTime: now, mediaTime: offset, rate };
  };

  const estimateMediaTime = () => {
    const ctx = ctxRef.current;
    const s = startRef.current;
    if (!ctx) return s.mediaTime;
    return s.mediaTime + (ctx.currentTime - s.ctxTime) * s.rate;
  };

  const stopDriftTimer = () => {
    if (driftTimerRef.current !== null) {
      window.clearInterval(driftTimerRef.current);
      driftTimerRef.current = null;
    }
  };

  // Every 2 seconds, restart only if the audio has drifted more than 0.15 s from the video.
  const startDriftTimer = () => {
    stopDriftTimer();
    driftTimerRef.current = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused || voicesRef.current.length === 0) return;
      if (Math.abs(estimateMediaTime() - v.currentTime) > 0.15) {
        startVoices(v.currentTime, v.playbackRate);
      }
    }, 2000);
  };

  useEffect(() => {
    return () => {
      stopVoices();
      stopDriftTimer();
      void ctxRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Video handlers. The video is muted, so all sound comes from the Web Audio tracks.
  const onPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    startVoices(v.currentTime, v.playbackRate);
    startDriftTimer();
  };

  const onPause = () => {
    stopVoices();
    stopDriftTimer();
  };

  const onSeeked = () => {
    const v = videoRef.current;
    if (v && !v.paused) startVoices(v.currentTime, v.playbackRate);
  };

  const onRateChange = () => {
    const v = videoRef.current;
    if (v && !v.paused) startVoices(v.currentTime, v.playbackRate);
  };

  // A learned profile belongs to one stretch of one file, so changing either clears it.
  const clearProfile = () => {
    profileRef.current = null;
    setNoiseLearned(false);
  };

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    stopVoices();
    stopDriftTimer();
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setCleanReady(false);
    setMode('cleaned');
    modeRef.current = 'cleaned';
    buffersRef.current = {};
    trackGainsRef.current = {};
    clearProfile();
    setStatus(`Loaded ${f.name}. Decoding original audio...`);
    try {
      buffersRef.current.orig = clipForTier(await decodeAudio(f));
      setStatus(`Loaded ${f.name}. Learn the room noise if you want it removed, then export.`);
    } catch {
      setStatus(`Loaded ${f.name}. Could not decode the original audio for compare.`);
    }
  };

  // Learns the steady noise from the stretch you chose, using the decoded original.
  const learnNoise = () => {
    const orig = buffersRef.current.orig;
    if (!orig) {
      setStatus('Load a clip first. The room noise is learned from it.');
      return;
    }
    const from = Number(noiseFrom);
    const to = Number(noiseTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > orig.duration || to - from < 0.5) {
      setStatus(`Pick a stretch of at least 0.5 seconds, between 0 and ${orig.duration.toFixed(1)} seconds.`);
      return;
    }
    try {
      const left = learnNoiseProfile(orig.getChannelData(0), orig.sampleRate, from, to);
      const right = orig.numberOfChannels > 1
        ? learnNoiseProfile(orig.getChannelData(1), orig.sampleRate, from, to)
        : left;
      profileRef.current = { left, right };
      setNoiseLearned(true);
      setStatus(`Room noise learned from ${from.toFixed(1)} to ${to.toFixed(1)} seconds. Export to apply it.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not learn the room noise.');
    }
  };

  const run = async (kind: 'mp4' | 'wav') => {
    if (!file || busy) return;
    setBusy(true);
    try {
      setStatus('Decoding audio...');
      const buf = clipForTier(await decodeAudio(file));
      const stereo = buf.numberOfChannels > 1;
      let L = new Float32Array(buf.getChannelData(0));
      let R = stereo ? new Float32Array(buf.getChannelData(1)) : new Float32Array(L);

      // Room-noise removal runs first, so the cleaning chain below works on the quieter signal.
      const profile = profileRef.current;
      if (profile) {
        setStatus('Removing room noise...');
        const split = stereo ? 50 : 100;
        L = await reduceRoomNoise(L, profile.left, reductionDb, (p) => setProgress(Math.round(p * split)));
        R = stereo
          ? await reduceRoomNoise(R, profile.right, reductionDb, (p) => setProgress(split + Math.round(p * (100 - split))))
          : L;
      }

      const span = kind === 'mp4' ? 50 : 100;
      setStatus('Rendering full track...');
      const wav = await renderCleanWav([L, R], buf.sampleRate, (p) => setProgress(Math.round(p * span)));
      const base = file.name.replace(/\.[^.]+$/, '');

      // Decode the cleaned WAV so it can play through the same engine as the original
      const ctx = getCtx();
      buffersRef.current.clean = await ctx.decodeAudioData(await wav.arrayBuffer());
      matchGainRef.current = matchGain(buffersRef.current.orig, buffersRef.current.clean);
      ensureGains(ctx);
      applyMode('cleaned');
      setCleanReady(true);

      if (kind === 'wav') {
        download(wav, `${base}_Quietly_Cleaned.wav`);
        setStatus('Cleaned stereo WAV exported. Use Original / Cleaned to compare.');
      } else {
        setStatus('Remuxing video stream (zero re-encoding, 100% original video quality)...');
        const mp4 = await remuxCleanMp4(file, wav, (p) => setProgress(span + Math.round(p * 50)));
        download(mp4, `${base}_Quietly_Clean.mp4`);
        setStatus('Clean MP4 exported. Use Original / Cleaned to compare.');
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setStatus(`Export stopped: ${why}. Try Export WAV Only, which skips the video remux.`);
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-5 pt-6 pb-20">
      <Link to="/" className="text-sm text-stone hover:text-paper">← Back to Overview</Link>
      <h1 className="mt-6 font-serif text-4xl">{BRAND.name} Studio</h1>
      <div className="mt-6"><SubscribeButton /></div>
      <p className="mt-2 text-stone">Local restoration. Your files never leave this browser.</p>

      <section className="mt-8 rounded-2xl border border-line bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <input
            type="file"
            accept=".mp4,.mov,video/mp4,video/quicktime"
            onChange={pick}
            className="text-sm text-stone"
          />
          <button type="button" className={button} onClick={() => setShowVideo((v) => !v)}>
            {showVideo ? 'Hide video monitor' : 'Show video monitor'}
          </button>
        </div>

        {url && (
          <div className={showVideo ? 'mt-4' : 'hidden'}>
            <video
              ref={videoRef}
              src={url}
              muted
              playsInline
              controls
              onPlay={onPlay}
              onPause={onPause}
              onSeeked={onSeeked}
              onRateChange={onRateChange}
              className="aspect-video max-h-[180px] w-full rounded-xl bg-black object-contain"
            />
          </div>
        )}

        {cleanReady && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm text-stone">Compare:</span>
            <button
              type="button"
              className={mode === 'original' ? activeButton : button}
              onClick={() => applyMode('original')}
            >
              Original
            </button>
            <button
              type="button"
              className={mode === 'cleaned' ? activeButton : button}
              onClick={() => applyMode('cleaned')}
            >
              Cleaned
            </button>
          </div>
        )}

        <div className="mt-5 rounded-xl border border-line p-4">
          <p className="text-sm text-paper">Room noise (optional)</p>
          <p className="mt-1 text-xs text-stone">
            Choose a stretch with only the steady sound, like an AC or fan, and no voice. Then learn it before exporting.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-stone">
            <label className="flex items-center gap-2">
              From
              <input
                type="number"
                min={0}
                step={0.5}
                value={noiseFrom}
                onChange={(e) => { setNoiseFrom(e.target.value); clearProfile(); }}
                className="w-20 rounded border border-line bg-[#121110] px-2 py-1 text-paper"
              />
              s
            </label>
            <label className="flex items-center gap-2">
              To
              <input
                type="number"
                min={0}
                step={0.5}
                value={noiseTo}
                onChange={(e) => { setNoiseTo(e.target.value); clearProfile(); }}
                className="w-20 rounded border border-line bg-[#121110] px-2 py-1 text-paper"
              />
              s
            </label>
            <button type="button" className={button} disabled={!file || busy} onClick={learnNoise}>
              Learn room noise
            </button>
            <span>{noiseLearned ? 'Learned' : 'Not learned yet'}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-stone">
            <label className="flex items-center gap-3">
              Reduction
              <input
                type="range"
                min={0}
                max={18}
                step={1}
                value={reductionDb}
                onChange={(e) => setReductionDb(Number(e.target.value))}
              />
              <span className="w-14 text-paper">{reductionDb} dB</span>
            </label>
          </div>
          <p className="mt-2 text-xs text-stone">
            Higher reduction removes more of the steady sound but can thin whispers. Start at 10 dB and listen.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!file || busy || FREE_TIER}
            onClick={() => run('mp4')}
            className="rounded-xl bg-amber px-4 py-2 font-semibold text-[#1a140d] disabled:opacity-40"
          >
            Export Cleaned MP4 Video
          </button>
          <button
            type="button"
            disabled={!file || busy}
            onClick={() => run('wav')}
            className="rounded-xl border border-amber px-4 py-2 text-amber disabled:opacity-40"
          >
            Export WAV Only
          </button>
        </div>

        {busy && (
          <div className="mt-4 h-1.5 overflow-hidden rounded bg-[#0E0D0C]">
            <div className="h-full bg-sage transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
        <p className="mt-3 font-mono text-xs text-stone">
          {status}
          {busy ? ` ${progress}%` : ''}
        </p>
      </section>
    </main>
  );
}
