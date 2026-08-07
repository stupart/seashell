import { renderText } from './transcript-renderer.ts';
import { transcribeMedia } from './transcription-service.ts';

/** Backward-compatible plain-text adapter over the canonical timed pipeline. */
export async function transcribeFile(
  filePath: string,
  onProgress?: (pct: number) => void,
): Promise<{ text: string; error?: string }> {
  try {
    const record = await transcribeMedia(filePath, {
      onWhisperProgress: onProgress,
    });
    return { text: renderText(record) };
  } catch (error) {
    return {
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
