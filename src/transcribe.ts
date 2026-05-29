import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..');
const WHISPER_CLI = join(PROJECT_ROOT, 'whisper.cpp/build/bin/whisper-cli');
const MODEL_PATH = join(PROJECT_ROOT, 'models/ggml-large-v3-turbo-q5_0.bin');
const VAD_MODEL_PATH = join(PROJECT_ROOT, 'whisper.cpp/models/ggml-silero-v6.2.0.bin');

// Formats that whisper-cli handles natively
const NATIVE_FORMATS = new Set(['wav', 'mp3', 'ogg', 'flac']);

export async function transcribeFile(
  filePath: string,
  onProgress?: (pct: number) => void,
): Promise<{ text: string; error?: string }> {
  if (!existsSync(filePath)) {
    return { text: '', error: `File not found: ${filePath}` };
  }

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  let inputPath = filePath;
  let tempWav: string | null = null;

  // Convert non-native formats to WAV via afconvert
  if (!NATIVE_FORMATS.has(ext)) {
    tempWav = `/tmp/seashell-convert-${Date.now()}.wav`;
    try {
      const proc = Bun.spawn(['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', filePath, tempWav]);
      await proc.exited;
      if (proc.exitCode !== 0) {
        return { text: '', error: `Failed to convert ${ext} file` };
      }
      inputPath = tempWav;
    } catch {
      return { text: '', error: `Failed to convert ${ext} file` };
    }
  }

  return new Promise((resolve) => {
    const proc = spawn(WHISPER_CLI, [
      '-m', MODEL_PATH,
      '-vm', VAD_MODEL_PATH,
      '--vad',
      '-f', inputPath,
      '-l', 'en',
      '-t', '6',
      '-nt',
      '-np',
      '-mc', '0',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      if (onProgress) {
        const match = text.match(/progress\s*=\s*(\d+)%/);
        if (match) onProgress(parseInt(match[1]));
      }
    });

    proc.on('close', (code) => {
      if (tempWav) {
        try { unlinkSync(tempWav); } catch {}
      }

      const cleaned = output
        .replace(/\[.*?\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (code !== 0 && !cleaned) {
        resolve({ text: '', error: 'Transcription failed' });
      } else {
        resolve({ text: cleaned });
      }
    });

    proc.on('error', (err) => {
      if (tempWav) {
        try { unlinkSync(tempWav); } catch {}
      }
      resolve({ text: '', error: `Transcription failed: ${err.message}` });
    });
  });
}
