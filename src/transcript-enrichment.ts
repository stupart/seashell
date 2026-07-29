import type {
  StructuredTranscript,
  TranscriptInsights,
} from './transcript-types.ts';

export interface TranscriptEnrichmentInput {
  transcript: StructuredTranscript['transcript'];
  speakers: StructuredTranscript['speakers'];
}

/**
 * Provider-neutral seam for a later summary/decisions/action-items pass.
 * Implementations may call a local model, a hosted model, or no model at all.
 */
export interface TranscriptEnricher {
  enrich(input: TranscriptEnrichmentInput): Promise<TranscriptInsights>;
}

export async function applyTranscriptEnrichment(
  document: StructuredTranscript,
  enricher: TranscriptEnricher,
): Promise<StructuredTranscript> {
  const insights = await enricher.enrich({
    transcript: document.transcript,
    speakers: document.speakers,
  });

  if (!insights || typeof insights !== 'object') {
    throw new Error('Transcript enricher must return an object');
  }

  const enriched: StructuredTranscript = { ...document };
  if (insights.summary !== undefined) {
    if (typeof insights.summary !== 'string') {
      throw new Error('Transcript summary must be a string');
    }
    enriched.summary = insights.summary;
  }
  if (insights.decisions !== undefined) {
    if (
      !Array.isArray(insights.decisions) ||
      insights.decisions.some((decision) => typeof decision !== 'string')
    ) {
      throw new Error('Transcript decisions must be an array of strings');
    }
    enriched.decisions = [...insights.decisions];
  }
  if (insights.action_items !== undefined) {
    if (
      !Array.isArray(insights.action_items) ||
      insights.action_items.some(
        (item) =>
          !item ||
          typeof item.owner !== 'string' ||
          typeof item.task !== 'string',
      )
    ) {
      throw new Error('Transcript action_items must contain owner/task strings');
    }
    enriched.action_items = insights.action_items.map((item) => ({ ...item }));
  }

  return enriched;
}
