import { setTimeout as sleep } from 'timers/promises';
import { finalizeCaptureTranscript } from './capture-finalizer.ts';
import { readMacCalendarEventsAsync, suggestCalendarMeeting } from './calendar.ts';
import {
  loadConfig,
  resolveLibraryDir,
  resolveMeetingRoute,
  type SeashellConfig,
} from './config.ts';
import {
  startDurableLiveCapture,
  type DurableLiveCaptureHandle,
} from './durable-live-capture.ts';
import {
  DEFAULT_MEETING_AUTOMATION,
  MeetingAutomationController,
  readMeetingSignalSnapshot,
  resolveMeetingCandidate,
  type MeetingAutomationAction,
  type MeetingCandidate,
  type MeetingSignalSnapshot,
} from './meeting-automation.ts';
import {
  createMeetingArtifact,
  saveMeetingArtifact,
} from './meeting-artifact.ts';
import { enrichMeeting } from './meeting-enrichment.ts';
import { applySpeakerLabels, EvidenceSpeakerLabeler } from './speaker-labeling.ts';
import { saveTranscriptRecord } from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import {
  DEFAULT_TRANSCRIPTION_ROUTING,
  selectCanonicalTranscriptionRoute,
} from './transcription-routing.ts';
import { acquireMeetingWatchLock } from './watch-lock.ts';
import { buildMeetingContext } from './meeting-context.ts';
import { consumeMeetingConsent } from './meeting-consent.ts';

export type AutomaticMeetingWatchEvent =
  | { readonly type: 'watch.ready'; readonly at: string }
  | { readonly type: 'meeting.suggested'; readonly at: string; readonly candidate: MeetingCandidate }
  | { readonly type: 'meeting.started'; readonly at: string; readonly candidate: MeetingCandidate; readonly sessionId: string }
  | { readonly type: 'meeting.capture-finished'; readonly at: string; readonly candidate: MeetingCandidate; readonly sessionId: string }
  | { readonly type: 'meeting.ready'; readonly at: string; readonly candidate: MeetingCandidate; readonly transcriptId: string; readonly directory: string }
  | { readonly type: 'watch.warning'; readonly at: string; readonly message: string }
  | { readonly type: 'watch.error'; readonly at: string; readonly message: string };

export interface AutomaticMeetingWatchDependencies {
  readonly now?: () => Date;
  readonly readSignals?: () => MeetingSignalSnapshot;
  readonly readCalendar?: typeof readMacCalendarEventsAsync;
  readonly startCapture?: typeof startDurableLiveCapture;
  readonly finalizeCapture?: typeof finalizeCaptureTranscript;
  readonly enrich?: typeof enrichMeeting;
  readonly consumeConsent?: typeof consumeMeetingConsent;
}

export interface AutomaticMeetingWatchOptions {
  readonly config?: SeashellConfig;
  readonly libraryDir?: string;
  readonly signal?: AbortSignal;
  readonly once?: boolean;
  readonly onEvent?: (event: AutomaticMeetingWatchEvent) => void;
  readonly dependencies?: AutomaticMeetingWatchDependencies;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function event<T extends AutomaticMeetingWatchEvent>(value: T): T {
  return Object.freeze(value);
}

export class AutomaticMeetingWatchService {
  readonly #config: SeashellConfig;
  readonly #libraryDir: string;
  readonly #controller: MeetingAutomationController;
  readonly #onEvent?: (event: AutomaticMeetingWatchEvent) => void;
  readonly #dependencies: Required<AutomaticMeetingWatchDependencies>;
  #active?: { candidate: MeetingCandidate; capture: DurableLiveCaptureHandle };
  #finalizationTail: Promise<void> = Promise.resolve();
  #calendarCache?: { readAtUnixMs: number; events: Awaited<ReturnType<typeof readMacCalendarEventsAsync>> };
  #calendarRead?: Promise<void>;
  #calendarAbort = new AbortController();
  #shuttingDown = false;

  constructor(options: AutomaticMeetingWatchOptions = {}) {
    this.#config = options.config ?? loadConfig();
    this.#libraryDir = resolveLibraryDir(options.libraryDir, process.env, this.#config);
    this.#controller = new MeetingAutomationController(this.#config.meeting?.automation);
    this.#onEvent = options.onEvent;
    this.#dependencies = {
      now: options.dependencies?.now ?? (() => new Date()),
      readSignals: options.dependencies?.readSignals ?? readMeetingSignalSnapshot,
      readCalendar: options.dependencies?.readCalendar ?? readMacCalendarEventsAsync,
      startCapture: options.dependencies?.startCapture ?? startDurableLiveCapture,
      finalizeCapture: options.dependencies?.finalizeCapture ?? finalizeCaptureTranscript,
      enrich: options.dependencies?.enrich ?? enrichMeeting,
      consumeConsent: options.dependencies?.consumeConsent ?? consumeMeetingConsent,
    };
  }

  get phase() {
    return this.#controller.state.phase;
  }

  async pollOnce(): Promise<MeetingAutomationAction> {
    const now = this.#dependencies.now();
    let snapshot: MeetingSignalSnapshot;
    try {
      snapshot = this.#dependencies.readSignals();
    } catch (error) {
      this.emit({ type: 'watch.warning', at: now.toISOString(), message: errorMessage(error) });
      return { kind: 'none' };
    }
    const calendar = this.currentCalendar(now);
    const candidate = resolveMeetingCandidate(snapshot, calendar, this.#config.meeting?.automation);
    const action = this.#controller.step(candidate, now.getTime());
    if (action.kind === 'suggest') {
      this.emit({ type: 'meeting.suggested', at: now.toISOString(), candidate: action.candidate });
    } else if (action.kind === 'start') {
      this.start(action.candidate, now);
    } else if (action.kind === 'finish') {
      await this.finish(action.candidate, action.reason);
    }
    if (this.#controller.state.phase === 'awaiting-consent') {
      const decision = this.#dependencies.consumeConsent(undefined, now.getTime());
      if (decision === 'approve') {
        const approved = this.approveSuggestion();
        return approved ? { kind: 'start', candidate: approved } : action;
      }
      if (decision === 'decline') this.declineSuggestion();
    }
    return action;
  }

  approveSuggestion(): MeetingCandidate | undefined {
    const now = this.#dependencies.now();
    const candidate = this.#controller.approve(now.getTime());
    if (candidate) this.start(candidate, now);
    return candidate;
  }

  declineSuggestion(): void {
    this.#controller.decline(this.#dependencies.now().getTime());
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#calendarAbort.abort();
    if (this.#active) await this.finish(this.#active.candidate, 'watch-stopped');
    await this.#calendarRead?.catch(() => {});
    await this.#finalizationTail;
  }

  private currentCalendar(now: Date) {
    const calendar = this.#config.meeting?.calendar;
    if (!calendar?.enabled || (calendar.policy ?? 'ask') === 'off') return undefined;
    try {
      if ((!this.#calendarCache || now.getTime() - this.#calendarCache.readAtUnixMs >= 30_000) &&
          !this.#calendarRead) {
        this.#calendarRead = this.#dependencies.readCalendar({
          leadMinutes: calendar.leadMinutes,
          signal: this.#calendarAbort.signal,
        })
          .then((events) => {
            this.#calendarCache = { readAtUnixMs: this.#dependencies.now().getTime(), events };
          })
          .catch((error: unknown) => {
            if (this.#shuttingDown) return;
            this.emit({
              type: 'watch.warning',
              at: this.#dependencies.now().toISOString(),
              message: errorMessage(error),
            });
          })
          .finally(() => { this.#calendarRead = undefined; });
      }
      if (!this.#calendarCache) return undefined;
      return suggestCalendarMeeting(this.#calendarCache.events, {
        policy: calendar.policy ?? 'ask',
        selectedCalendars: calendar.selectedCalendars,
        leadMinutes: calendar.leadMinutes,
        now,
      });
    } catch { return undefined; }
  }

  private start(candidate: MeetingCandidate, now: Date): void {
    if (this.#active) return;
    const capture = this.#dependencies.startCapture({
      libraryDir: this.#libraryDir,
      startedAt: now,
      onError: (error) => this.emit({
        type: 'watch.warning',
        at: this.#dependencies.now().toISOString(),
        message: error.message,
      }),
    });
    this.#active = { candidate, capture };
    this.emit({
      type: 'meeting.started',
      at: now.toISOString(),
      candidate,
      sessionId: capture.sessionId,
    });
  }

  private async finish(candidate: MeetingCandidate, reason: string): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    try {
      await active.capture.stop(reason);
      this.emit({
        type: 'meeting.capture-finished',
        at: this.#dependencies.now().toISOString(),
        candidate,
        sessionId: active.capture.sessionId,
      });
      const task = async () => this.finalize(active.candidate, active.capture);
      this.#finalizationTail = this.#finalizationTail.then(task, task).catch((error: unknown) => {
        this.emit({
          type: 'watch.error',
          at: this.#dependencies.now().toISOString(),
          message: `Meeting ${active.capture.sessionId} remains recoverable: ${errorMessage(error)}`,
        });
      });
    } catch (error) {
      this.emit({
        type: 'watch.error',
        at: this.#dependencies.now().toISOString(),
        message: `Could not stop meeting capture: ${errorMessage(error)}`,
      });
    }
  }

  private async finalize(
    candidate: MeetingCandidate,
    capture: DurableLiveCaptureHandle,
  ): Promise<void> {
    const routing = this.#config.transcription ?? DEFAULT_TRANSCRIPTION_ROUTING;
    const canonical = selectCanonicalTranscriptionRoute(routing);
    const cloud = routing.cloud;
    let record: TranscriptRecord = await this.#dependencies.finalizeCapture(capture.manifestPath, {
      title: candidate.title,
      ...(canonical === 'cloud' && cloud?.uploadConsent ? {
        remoteRoute: {
          model: cloud.model,
          ...(cloud.upstreamProvider === undefined ? {} : { upstreamProvider: cloud.upstreamProvider }),
          ...(cloud.maxCostMicrousd === undefined ? {} : { maxCostMicrousd: cloud.maxCostMicrousd }),
          uploadConsent: true as const,
        },
      } : {}),
    });
    if (candidate.calendar?.attendees.length) {
      record = await applySpeakerLabels(record, new EvidenceSpeakerLabeler(), {
        attendees: candidate.calendar.attendees.map((attendee) => ({
          name: attendee.name,
          ...(attendee.email === undefined ? {} : { email: attendee.email }),
        })),
        screenshots: [],
        activeSpeakers: [],
      }) as TranscriptRecord;
    }
    const saved = saveTranscriptRecord(this.#libraryDir, record);
    capture.store.setStatus('completed', 'automatic-meeting-finalized');
    capture.store.attachTo(saved.directory);
    let artifact = createMeetingArtifact(record, {
      mode: this.#config.meeting?.mode ?? 'hybrid',
      ...(candidate.calendar === undefined ? {} : { calendar: candidate.calendar }),
      maxObserverRuns: this.#config.meeting?.maxObserverRuns,
    });
    saveMeetingArtifact(this.#libraryDir, artifact);
    const mode = this.#config.meeting?.mode ?? artifact.mode;
    const observer = resolveMeetingRoute(this.#config.meeting, 'observer');
    const reconciliation = resolveMeetingRoute(this.#config.meeting, 'reconciliation');
    const hasRequiredRoutes = (mode === 'post-session' || observer) &&
      (mode === 'streaming' || reconciliation);
    if (hasRequiredRoutes) {
      artifact = await this.#dependencies.enrich(this.#libraryDir, record.id, {
        mode,
        routes: {
          ...(observer === undefined ? {} : { observer }),
          ...(reconciliation === undefined ? {} : { reconciliation }),
        },
        minimumNewSegments: this.#config.meeting?.observerMinSegments,
        maximumNewSegments: this.#config.meeting?.observerMaxSegments,
        maxObserverRuns: this.#config.meeting?.maxObserverRuns,
        context: buildMeetingContext(
          this.#config.meeting?.contextFiles,
          candidate.calendar,
        ),
      });
    }
    this.emit({
      type: 'meeting.ready',
      at: this.#dependencies.now().toISOString(),
      candidate,
      transcriptId: artifact.transcriptId,
      directory: saved.directory,
    });
  }

  private emit(value: AutomaticMeetingWatchEvent): void {
    this.#onEvent?.(event(value));
  }
}

export async function runAutomaticMeetingWatch(options: AutomaticMeetingWatchOptions = {}): Promise<void> {
  const lock = acquireMeetingWatchLock();
  if (!lock) throw new Error('Another Sea Shell meeting watcher is already running');
  const service = new AutomaticMeetingWatchService(options);
  try {
    options.onEvent?.(event({ type: 'watch.ready', at: new Date().toISOString() }));
    if (options.once) {
      await service.pollOnce();
      return;
    }
    const pollSeconds = options.config?.meeting?.automation?.pollSeconds ??
      DEFAULT_MEETING_AUTOMATION.pollSeconds;
    while (!options.signal?.aborted) {
      await service.pollOnce();
      await sleep(pollSeconds * 1_000, undefined, { signal: options.signal }).catch(() => {});
    }
  } finally {
    await service.shutdown();
    lock.release();
  }
}
