import { useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';
import { renderCleanWav } from '../lib/dsp';
import { extractAudioWav, remuxCleanMp4 } from '../lib/ffmpegRemux';

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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

const button = 'rounded-xl border border-line bg-card px-3 py-2 text-sm text-paper hover:border-stone';

export default function StudioPage() {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('Choose a camera video (.mp4 or .mov) to begin.');

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setStatus(`Loaded ${f.name}. Export the cleaned video or the WAV.`);
  };

  const run = async (kind: 'mp4' | 'wav') => {
    if (!file || busy) return;
    setBusy(true);
    try {
      setStatus('Decoding audio...');
      const buf = await decodeAudio(file);
      const L = new Float32Array(buf.getChannelData(0));
      const R = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : new Float32Array(L);
      const span = kind === 'mp4' ? 50 : 100;
      setStatus('Rendering full track...');
      const wav = await renderCleanWav([L, R], buf.sampleRate, (p) => setProgress(Math.round(p * span)));
      const base = file.name.replace(/\.[^.]+$/, '');
      if (kind === 'wav') {
        download(wav, `${base}_Quietly_Cleaned.wav`);

        setStatus('Cleaned stereo WAV exported.');
      } else {
        setStatus('Remuxing video stream (zero re-encoding, 100% original video quality)...');
        const mp4 = await remuxCleanMp4(file, wav, (p) => setProgress(span + Math.round(p * 50)));
        download(mp4, `${base}_Quietly_Clean.mp4`);
        setStatus('Clean MP4 exported.');
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

        {url && showVideo && (
          <video
            src={url}
            muted
            playsInline
            controls
            className="mt-4 aspect-video max-h-[180px] w-full rounded-xl bg-black object-contain"
          />
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!file || busy}
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
