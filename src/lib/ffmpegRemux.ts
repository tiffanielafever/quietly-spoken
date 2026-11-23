import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

// Single-threaded core: no SharedArrayBuffer, so no COOP/COEP headers are needed.
// Inputs are mounted with WORKERFS, which reads from the user's disk through File handles
// instead of copying them into MEMFS. Outputs are still written to MEMFS, so the output
// must fit in the WebAssembly heap.

const MOUNT = '/input_dir';

// Loose local typing, so this wrapper compiles against either revision of the FFmpeg typings.
interface FsApi {
  createDir(path: string): Promise<unknown>;
  mount(fsType: string, options: { files: File[] }, mountPoint: string): Promise<unknown>;
  unmount(mountPoint: string): Promise<unknown>;
  deleteDir(path: string): Promise<unknown>;
}

let engine: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let progressSink: ((p: number) => void) | null = null;

export function loadEngine(): Promise<FFmpeg> {
  if (engine) return Promise.resolve(engine);
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      ff.on('progress', ({ progress }) => progressSink?.(progress));
      await ff.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      engine = ff;
      return ff;
    })().catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

async function withMount<T>(ff: FFmpeg, files: File[], job: () => Promise<T>): Promise<T> {
  const fs = ff as unknown as FsApi;
  try { await fs.createDir(MOUNT); } catch { /* left over from an earlier run */ }
  await fs.mount('WORKERFS', { files }, MOUNT);
  try {
    return await job();
  } finally {
    // Release the mount and its directory so memory stays flat across repeated exports
    try { await fs.unmount(MOUNT); } catch { /* not mounted */ }
    try { await fs.deleteDir(MOUNT); } catch { /* already gone */ }
  }
}

// Lossless remux: the source video stream is copied, the cleaned WAV becomes AAC 320 kbps audio.
export async function remuxCleanMp4(video: File, cleanWav: Blob, onProgress: (p: number) => void): Promise<Blob> {
  const ff = await loadEngine();
  const wav = new File([cleanWav], 'cleaned_audio.wav', { type: 'audio/wav' });
  const out = 'output_clean.mp4';
  progressSink = onProgress;
  try {
    return await withMount(ff, [video, wav], async () => {
      try {
        const code = await ff.exec([
          '-y',
          '-i', `${MOUNT}/${video.name}`,
          '-i', `${MOUNT}/cleaned_audio.wav`,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '320k',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-shortest',
          out,
        ]);
        if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
        const bytes = await ff.readFile(out);
        return new Blob([bytes as unknown as BlobPart], { type: 'video/mp4' });
      } finally {
        await ff.deleteFile(out).catch(() => undefined);
      }
    });
  } finally {
    progressSink = null;
  }
}

// Fallback when the browser cannot decode the container natively: extract audio as 48 kHz PCM WAV.
export async function extractAudioWav(video: File): Promise<Blob> {
  const ff = await loadEngine();
  return withMount(ff, [video], async () => {
    const out = 'audio.wav';
    try {
      const code = await ff.exec(['-y', '-i', `${MOUNT}/${video.name}`, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
      if (code !== 0) throw new Error(`Audio extraction exited with code ${code}`);
      const bytes = await ff.readFile(out);
      return new Blob([bytes as unknown as BlobPart], { type: 'audio/wav' });
    } finally {
      await ff.deleteFile(out).catch(() => undefined);
    }
  });
}