import type { MeetProbe } from './meet-speakers.ts';
import { setTimeout as sleep } from 'timers/promises';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claimManagedProcessSignalOwnership } from './process-lifecycle.ts';
import { finalizeCaptureTranscript } from './capture-finalizer.ts';
import { readMacCalendarEventsAsync, suggestCalendarMeeting } from './calendar.ts';
import { meetBrowserMatchesApp, probeMeetSpeakers } from './meet-speakers.ts';
import { writeBackgroundMeetingState, type BackgroundMeetingState, type BackgroundMeetingStatusOptions } from './background-meeting-status.ts';
import { writeBackgroundWatchStatus } from './background-watch-status.ts';
import { startBackgroundLiveTranscript, type BackgroundLiveTranscriptHandle, type BackgroundLiveTranscriptStatus } from './background-live-transcript.ts';
import type { CommittedCaptureChunk } from './capture-session.ts';
import { captureHealthTransitionKey } from './capture-health.ts';
import { createTranscriptRecord } from './transcript-record.ts';
import {
  briefsEnabled,
  loadConfig,
  resolveLibraryDir,
  resolveMeetingRoute,
  type SeashellConfig,
} from './config.ts';
import {
  briefDue,
  briefKey,
  COMING_UP_HOURS,
  COMING_UP_LIMIT,
  findBrief,
  makeBrief,
  NoBriefHistoryError,
  recordBriefAttempt,
  relevantMeetings,
  upcomingCalendarMeetings,
  upcomingFromEvent,
  writeNextMeeting,
} from './briefs.ts';
import {
  startDurableLiveCapture,
  type DurableLiveCaptureHandle,
  type DurableLiveCaptureStatus,
} from './durable-live-capture.ts';
import {
  DEFAULT_MEETING_AUTOMATION,
  MeetingSignalMonitor,
  MeetingAutomationController,
  resolveMeetingCandidate,
  calendarEventIsThisCall,
  hasConfirmedMeetingEnd,
  isBrowserApplication,
  isVideoCallEvent,
  preserveMeetingCandidateDuringObservationGap,
  type MeetingAutomationAction,
  type MeetingCandidate,
  type MeetingSignalSnapshot,
} from './meeting-automation.ts';
import {
  createMeetingArtifact,
  readMeetingAiSettings,
  loadMeetingArtifact,
  saveMeetingArtifact,
} from './meeting-artifact.ts';
import { enrichMeeting } from './meeting-enrichment.ts';
import { applySpeakerLabels, EvidenceSpeakerLabeler } from './speaker-labeling.ts';
import { findTranscriptRecord, saveTranscriptRecord } from './transcript-library.ts';
import type { TranscriptRecord } from './transcript-types.ts';
import {
  DEFAULT_TRANSCRIPTION_ROUTING,
  selectCanonicalTranscriptionRoute,
} from './transcription-routing.ts';
import { acquireMeetingWatchLock } from './watch-lock.ts';
import { buildMeetingContext } from './meeting-context.ts';
import { consumeMeetingConsent, writeMeetingConsent } from './meeting-consent.ts';
import { consumeMeetingCommand } from './meeting-command.ts';
import { addRecordingNote, consumeNoteCommands, mergeOwnerNotes, readBundleNotes, savedOwnerNotes } from './owner-notes.ts';
import { meetingVideoRequest } from './video-recording.ts';

export type AutomaticMeetingWatchEvent =
  | { readonly type: 'watch.ready'; readonly at: string }
  /** `why` says what kept it from recording by itself, so a missed call can be explained. */
  | { readonly type: 'meeting.suggested'; readonly at: string; readonly candidate: MeetingCandidate; readonly why?: string }
  | { readonly type: 'meeting.stopped'; readonly at: string; readonly candidate: MeetingCandidate }
  | { readonly type: 'meeting.started'; readonly at: string; readonly candidate: MeetingCandidate; readonly sessionId: string }
  | { readonly type: 'meeting.resumed'; readonly at: string; readonly candidate: MeetingCandidate; readonly sessionId: string; readonly pausedSeconds: number }
  | { readonly type: 'meeting.capture-finished'; readonly at: string; readonly candidate: MeetingCandidate; readonly sessionId: string }
  | { readonly type: 'meeting.ready'; readonly at: string; readonly candidate: MeetingCandidate; readonly transcriptId: string; readonly directory: string }
  | { readonly type: 'brief.ready'; readonly at: string; readonly title: string; readonly path: string }
  | { readonly type: 'watch.warning'; readonly at: string; readonly message: string }
  | { readonly type: 'watch.restarting'; readonly at: string; readonly reason: string }
  | { readonly type: 'watch.error'; readonly at: string; readonly message: string };

export interface AutomaticMeetingWatchDependencies {
  readonly now?: () => Date;
  readonly readSignals?: () => MeetingSignalSnapshot | Promise<MeetingSignalSnapshot>;
  readonly readMeet?: typeof probeMeetSpeakers;
  readonly readCalendar?: typeof readMacCalendarEventsAsync;
  readonly startCapture?: typeof startDurableLiveCapture;
  readonly startLiveTranscript?: typeof startBackgroundLiveTranscript;
  readonly finalizeCapture?: typeof finalizeCaptureTranscript;
  readonly enrich?: typeof enrichMeeting;
  readonly consumeConsent?: typeof consumeMeetingConsent;
  readonly consumeCommand?: typeof consumeMeetingCommand;
  /** Notes typed with `seashell note` during a recording. */
  readonly consumeNotes?: typeof consumeNoteCommands;
  /**
   * Ask the person directly whether to record, when no Seashell window may be
   * open to ask. Resolves with their answer, or undefined if they did not
   * answer. Only the login agent passes one: tests and embedders never prompt.
   */
  readonly askToRecord?: (candidate: MeetingCandidate, signal: AbortSignal) => Promise<'approve' | 'decline' | undefined>;
  /** Writes a brief before a meeting; tests pass one that sends nothing. */
  readonly makeBrief?: typeof makeBrief;
  /**
   * Tells the person a brief is ready, once per meeting. Only the login agent
   * passes one: tests and embedders never notify.
   */
  readonly notify?: (message: string) => void;
}

export interface AutomaticMeetingWatchOptions {
  readonly config?: SeashellConfig;
  readonly libraryDir?: string;
  readonly signal?: AbortSignal;
  readonly once?: boolean;
  /** Isolated embedders/tests may supply their own lock; CLI uses the user lock. */
  readonly lockPath?: string;
  readonly onEvent?: (event: AutomaticMeetingWatchEvent) => void;
  readonly dependencies?: AutomaticMeetingWatchDependencies;
  /**
   * Polled between meetings only. A reason ends the watch so its supervisor
   * (launchd) starts a fresh one on the current code and settings.
   */
  readonly restartWhen?: () => string | undefined;
}

/**
 * Why a long-running watcher should be replaced: a package upgrade moved or
 * removed the code and helpers it runs from, or settings changed on disk.
 */
export function watchRestartReason(options: { readonly configPath: string; readonly packageRoot?: string; readonly codeRoot: string }): () => string | undefined {
  const configStamp = () => { try { return statSync(options.configPath).mtimeMs; } catch { return 0; } };
  const resolvedPackage = () => { try { return options.packageRoot ? realpathSync(options.packageRoot) : undefined; } catch { return undefined; } };
  const initialConfig = configStamp();
  const initialPackage = resolvedPackage();
  return () => {
    if (!existsSync(join(options.codeRoot, 'package.json')) || resolvedPackage() !== initialPackage) return 'Seashell was updated';
    if (configStamp() !== initialConfig) return 'Settings changed';
    return undefined;
  };
}

/** A browser that was in front this recently may still hold a call joined just before switching away. */
const BROWSER_RECENT_MS = 5 * 60_000;
/** How often a video call on the calendar is checked for, whatever is in front. */
const CALENDAR_CALL_CHECK_MS = 30_000;
/** How close to a video call on the calendar, before its start or after its end, it is checked for. */
const CALENDAR_CALL_WINDOW_MINUTES = 15;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function event<T extends AutomaticMeetingWatchEvent>(value: T): T {
  return Object.freeze(value);
}

interface ActiveMeeting {
  readonly candidate: MeetingCandidate;
  readonly capture: DurableLiveCaptureHandle;
  readonly directory: string;
  readonly startedAt: Date;
  readonly draft?: BackgroundLiveTranscriptHandle;
}

export class AutomaticMeetingWatchService {
  readonly #config: SeashellConfig;
  readonly #libraryDir: string;
  readonly #controller: MeetingAutomationController;
  readonly #onEvent?: (event: AutomaticMeetingWatchEvent) => void;
  readonly #dependencies: Required<AutomaticMeetingWatchDependencies>;
  readonly #signalMonitor?: MeetingSignalMonitor;
  #active?: ActiveMeeting;
  /** A stopped meeting whose final pass waits briefly in case the call resumes. */
  #parked?: ActiveMeeting & { readonly parkedAtUnixMs: number; readonly resumeUntilUnixMs: number };
  #finalizationTail: Promise<void> = Promise.resolve();
  #calendarCache?: { readAtUnixMs: number; events: Awaited<ReturnType<typeof readMacCalendarEventsAsync>> };
  #calendarRead?: Promise<void>;
  #calendarRetryAtUnixMs = 0;
  #calendarAbort = new AbortController();
  #shuttingDown = false;
  #meetWarning?: string;
  #consentId?: string;
  #asking?: AbortController;
  #lastNowUnixMs = Date.now();
  #browserFrontAtUnixMs = Number.NEGATIVE_INFINITY;
  #meetCheckedAtUnixMs = Number.NEGATIVE_INFINITY;
  /** The calendar a few hours ahead, read every few minutes, for the next meeting and its brief. */
  #ahead?: { readAtUnixMs: number; events: Awaited<ReturnType<typeof readMacCalendarEventsAsync>> };
  #aheadRead?: Promise<void>;
  #briefing?: Promise<void>;

  constructor(options: AutomaticMeetingWatchOptions = {}) {
    this.#config = options.config ?? loadConfig();
    this.#libraryDir = resolveLibraryDir(options.libraryDir, process.env, this.#config);
    this.#controller = new MeetingAutomationController(this.#config.meeting?.automation);
    this.#onEvent = options.onEvent;
    const pollMs = (this.#config.meeting?.automation?.pollSeconds ??
      DEFAULT_MEETING_AUTOMATION.pollSeconds) * 1_000;
    this.#signalMonitor = options.dependencies?.readSignals
      ? undefined
      : new MeetingSignalMonitor(undefined, pollMs);
    this.#dependencies = {
      now: options.dependencies?.now ?? (() => new Date()),
      readSignals: options.dependencies?.readSignals ?? (() => this.#signalMonitor!.waitForSnapshot()),
      readMeet: options.dependencies?.readMeet ?? probeMeetSpeakers,
      readCalendar: options.dependencies?.readCalendar ?? readMacCalendarEventsAsync,
      startCapture: options.dependencies?.startCapture ?? startDurableLiveCapture,
      startLiveTranscript: options.dependencies?.startLiveTranscript ?? startBackgroundLiveTranscript,
      finalizeCapture: options.dependencies?.finalizeCapture ?? finalizeCaptureTranscript,
      enrich: options.dependencies?.enrich ?? enrichMeeting,
      consumeConsent: options.dependencies?.consumeConsent ?? consumeMeetingConsent,
      consumeCommand: options.dependencies?.consumeCommand ?? consumeMeetingCommand,
      consumeNotes: options.dependencies?.consumeNotes ?? consumeNoteCommands,
      askToRecord: options.dependencies?.askToRecord ?? (async () => undefined),
      makeBrief: options.dependencies?.makeBrief ?? makeBrief,
      notify: options.dependencies?.notify ?? (() => {}),
    };
  }

  get phase() {
    return this.#controller.state.phase;
  }

  /** No meeting is recording, paused for resume, awaiting consent or being confirmed. */
  get idle(): boolean {
    return !this.#active && !this.#parked && this.#controller.state.phase === 'watching';
  }

  async pollOnce(): Promise<MeetingAutomationAction> {
    const now = this.#dependencies.now();
    this.#lastNowUnixMs = now.getTime();
    const automation = this.#config.meeting?.automation;
    const browser = automation?.enabled === false || automation?.mode === 'off'
      ? undefined : this.#config.meeting?.speakerBrowser;
    let snapshot: MeetingSignalSnapshot;
    try {
      snapshot = await this.#dependencies.readSignals();
    } catch (error) {
      this.emit({ type: 'watch.warning', at: now.toISOString(), message: errorMessage(error) });
      snapshot = { schemaVersion: 1, capturedAtUnixMs: now.getTime(), supported: false, inputProcesses: [] };
    }
    const skipMeet = Boolean(browser && browser !== 'off') && !this.meetCallPossible(snapshot, now);
    if (browser && browser !== 'off' && !skipMeet) this.#meetCheckedAtUnixMs = now.getTime();
    const meet = browser && browser !== 'off' && !skipMeet
      ? await this.#dependencies.readMeet(browser, this.#calendarAbort.signal).catch(() => ({
        state: 'unavailable' as const, detail: 'Could not check Google Meet. Check the connection in Speakers.',
      })) : undefined;
    // Any browser window Accessibility cannot read lands here: with no call
    // running that is routine, and a person cannot act on it. Lost access is not.
    const routine = meet?.state === 'unavailable' && (meet as MeetProbe).accessibilityTrusted === true &&
      !this.#active && this.#controller.state.phase === 'watching';
    // A skipped check learned nothing new, so an earlier warning still stands.
    if (meet && !routine && ['permission', 'ambiguous', 'unavailable'].includes(meet.state)) {
      if (this.#meetWarning !== meet.detail) this.emit({ type: 'watch.warning', at: now.toISOString(), message: meet.detail });
      this.#meetWarning = meet.detail;
    } else if (!skipMeet) this.#meetWarning = undefined;
    if (this.#shuttingDown) {
      return { kind: 'none' };
    }
    this.lookAhead(now);
    this.expireParked(now);
    const calendar = this.currentCalendar(now);
    const candidate = preserveMeetingCandidateDuringObservationGap(
      resolveMeetingCandidate(snapshot, calendar, this.#config.meeting?.automation, meet),
      this.#controller.state, snapshot, meet, this.#parked?.candidate,
    );
    // Notes first, so one typed just before stopping still lands in this recording.
    this.takeNotes(now);
    const command = this.#dependencies.consumeCommand(undefined, now.getTime());
    if (command === 'stop' && this.#active) {
      const stopped = this.#controller.stopByHand(now.getTime()) ?? this.#active.candidate;
      this.emit({ type: 'meeting.stopped', at: now.toISOString(), candidate: stopped });
      await this.finish(this.#active.candidate, 'stopped-by-hand');
      this.projectWatch();
      return { kind: 'none' };
    }
    if (command === 'start' && !this.#active) {
      const manual = Object.freeze({
        id: `manual:${randomUUID()}`, appName: 'Seashell', bundleId: '', pid: 0, kind: 'manual' as const,
        title: calendar?.title?.trim() || 'Recording', ...(calendar ? { calendar } : {}),
        evidence: Object.freeze(['manual' as const]), requiresConsent: false,
      });
      const started = this.#controller.startByHand(manual, now.getTime());
      if (started && this.start(started, now)) {
        this.projectWatch();
        return { kind: 'start', candidate: started };
      }
    }
    const action = this.#controller.step(candidate, now.getTime(),
      hasConfirmedMeetingEnd(this.#controller.state.candidate, meet));
    if (action.kind === 'suggest') {
      this.#consentId = randomUUID();
      const why = meet && meet.state !== 'connected' ? meet.detail : undefined;
      this.emit({ type: 'meeting.suggested', at: now.toISOString(), candidate: action.candidate, ...(why ? { why } : {}) });
      this.askToRecord(action.candidate, this.#consentId);
    } else if (action.kind === 'start') {
      if (!this.start(action.candidate, now)) { this.projectWatch(); return { kind: 'none' }; }
    } else if (action.kind === 'finish') {
      await this.finish(action.candidate, action.reason);
    }
    if (this.#controller.state.phase === 'awaiting-consent') {
      const decision = this.#dependencies.consumeConsent(undefined, now.getTime(), 120_000, this.#consentId);
      if (decision === 'approve') {
        const approved = this.approveSuggestion();
        this.projectWatch();
        return approved ? { kind: 'start', candidate: approved } : action;
      }
      if (decision === 'decline') this.declineSuggestion();
    }
    if (this.#controller.state.phase !== 'awaiting-consent') {
      this.#consentId = undefined;
      // Answered somewhere else, or the call went away: the question is moot.
      this.#asking?.abort();
      this.#asking = undefined;
    }
    this.projectWatch();
    return action;
  }

  /**
   * Notes from a terminal go into the recording's bundle, timed by when they
   * were typed. A recording paused for resume still takes them.
   */
  private takeNotes(now: Date): void {
    const meeting = this.#active ?? this.#parked;
    for (const note of this.#dependencies.consumeNotes(undefined, now.getTime())) {
      if (!meeting) {
        this.emit({ type: 'watch.warning', at: now.toISOString(), message: 'A note arrived with nothing recording, so it was not kept.' });
        continue;
      }
      try { addRecordingNote(meeting.capture.store.root, note.text, note.createdAtUnixMs); }
      catch (error) { this.emit({ type: 'watch.warning', at: now.toISOString(), message: `Could not keep a note: ${errorMessage(error)}` }); }
    }
  }

  /**
   * The next meeting on the calendar, for the app, and a brief about 15 minutes
   * before one that has history. Never waits: the calendar read and the brief
   * run beside the poll, one at a time. A meeting with no history, or a brief
   * that fails, is tried once and never mentioned.
   */
  private lookAhead(now: Date): void {
    const calendar = this.#config.meeting?.calendar;
    if (!calendar?.enabled || (calendar.policy ?? 'ask') === 'off') return;
    if ((!this.#ahead || now.getTime() - this.#ahead.readAtUnixMs >= 5 * 60_000) && !this.#aheadRead &&
        now.getTime() >= this.#calendarRetryAtUnixMs) {
      this.#aheadRead = this.#dependencies.readCalendar({ leadMinutes: COMING_UP_HOURS * 60, lookbackMinutes: 0, signal: this.#calendarAbort.signal })
        .then((events) => {
          this.#ahead = { readAtUnixMs: this.#dependencies.now().getTime(), events };
          this.publishNext(this.#dependencies.now());
        })
        // The calendar's own read reports a failure; this one waits for the next window.
        .catch(() => { this.#ahead = { readAtUnixMs: this.#dependencies.now().getTime(), events: this.#ahead?.events ?? [] }; })
        .finally(() => { this.#aheadRead = undefined; });
    }
    const route = resolveMeetingRoute(this.#config.meeting, 'reconciliation');
    if (!this.#ahead || this.#briefing || !route || !briefsEnabled(this.#config)) return;
    const due = briefDue(this.#ahead.events, this.#libraryDir, now);
    if (!due) return;
    const key = briefKey(due);
    this.#briefing = (async () => {
      try {
        const brief = await this.#dependencies.makeBrief(this.#libraryDir, due, { route, signal: this.#calendarAbort.signal });
        recordBriefAttempt(this.#libraryDir, key, { at: new Date().toISOString(), outcome: 'made' });
        this.#dependencies.notify(`Brief ready for ${due.title}`);
        this.emit({ type: 'brief.ready', at: this.#dependencies.now().toISOString(), title: due.title, path: brief.path });
      } catch (error) {
        if (this.#shuttingDown) return;
        const noHistory = error instanceof NoBriefHistoryError;
        recordBriefAttempt(this.#libraryDir, key, { at: new Date().toISOString(), outcome: noHistory ? 'no-history' : 'failed',
          ...(noHistory ? {} : { detail: errorMessage(error) }) });
        if (!noHistory) this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(), message: `No brief for ${due.title}: ${errorMessage(error)}` });
      } finally {
        this.publishNext(this.#dependencies.now());
      }
    })().finally(() => { this.#briefing = undefined; });
  }

  /**
   * What the app lists as coming up, over the next 36 hours, the nearest first: when each is, whether
   * there is a brief, or past meetings to make one from.
   */
  private publishNext(now: Date): void {
    try {
      const events = this.#ahead ? upcomingCalendarMeetings(this.#ahead.events, now).slice(0, COMING_UP_LIMIT) : [];
      const [nearest, ...later] = events.map((event) => {
        const upcoming = upcomingFromEvent(event);
        const brief = findBrief(this.#libraryDir, upcoming);
        return { upcoming, history: brief ? brief.meetings.length : relevantMeetings(this.#libraryDir, upcoming).length,
          ...(brief ? { brief: brief.path } : {}) };
      });
      if (!nearest) { writeNextMeeting(this.#libraryDir, undefined); return; }
      writeNextMeeting(this.#libraryDir, { ...nearest, ...(later.length ? { later } : {}) }, now.getTime());
    } catch (error) {
      this.emit({ type: 'watch.warning', at: now.toISOString(), message: `Could not save the next meeting: ${errorMessage(error)}` });
    }
  }

  /** The answer goes through the consent file, so the next poll acts on it like any other. */
  private askToRecord(candidate: MeetingCandidate, consentId: string): void {
    this.#asking?.abort();
    const asking = new AbortController();
    this.#asking = asking;
    void this.#dependencies.askToRecord(candidate, asking.signal).then((answer) => {
      if (!answer || asking.signal.aborted || this.#consentId !== consentId) return;
      writeMeetingConsent(answer, undefined, this.#dependencies.now().getTime(), consentId);
    }).catch((error: unknown) => {
      this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(),
        message: `Could not ask whether to record: ${errorMessage(error)}` });
    });
  }

  approveSuggestion(): MeetingCandidate | undefined {
    const now = this.#dependencies.now();
    this.#lastNowUnixMs = now.getTime();
    const candidate = this.#controller.approve(now.getTime());
    if (candidate && !this.start(candidate, now)) { this.projectWatch(); return undefined; }
    this.projectWatch();
    return candidate;
  }

  declineSuggestion(): void {
    this.#lastNowUnixMs = this.#dependencies.now().getTime();
    this.#controller.decline(this.#lastNowUnixMs);
    this.#consentId = undefined;
    this.projectWatch();
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#signalMonitor?.stop();
    this.#calendarAbort.abort();
    this.#asking?.abort();
    if (this.#active) await this.finish(this.#active.candidate, 'watch-stopped');
    this.finalizeParked();
    await this.#calendarRead?.catch(() => {});
    await this.#aheadRead?.catch(() => {});
    await this.#briefing?.catch(() => {});
    await this.#finalizationTail;
    this.#consentId = undefined;
    this.projectWatch();
  }

  /**
   * Checking Meet spawns a helper that walks Safari's and Chrome's Accessibility
   * trees, which is wasted work every few seconds while nothing call-like is
   * happening. Check every poll while a browser is in front (a muted call can be
   * joined there with no microphone in use) and for five minutes after, since a
   * call joined just before switching away is still running; while a browser
   * holds the microphone; and while a call is being confirmed, recorded or held
   * for resume. A video call on the calendar within 15 minutes is checked at
   * least every 30 s, whatever is in front: it is often joined in a background
   * tab or full screen on another desktop. If the signals cannot say what is in
   * front, check anyway.
   */
  private meetCallPossible(snapshot: MeetingSignalSnapshot, now: Date): boolean {
    if (this.#shuttingDown) return false;
    if (!snapshot.supported || snapshot.frontmostBundleId === undefined) return true;
    if (isBrowserApplication(snapshot.frontmostBundleId)) this.#browserFrontAtUnixMs = now.getTime();
    if (this.#active || this.#parked || this.#controller.state.phase !== 'watching') return true;
    if (now.getTime() - this.#browserFrontAtUnixMs < BROWSER_RECENT_MS ||
        snapshot.inputProcesses.some((process) => isBrowserApplication(process.bundleId))) return true;
    return now.getTime() - this.#meetCheckedAtUnixMs >= CALENDAR_CALL_CHECK_MS && this.videoCallNearby(now);
  }

  /** A video call on the calendar starts within 15 minutes, is running, or ended under 15 minutes ago. */
  private videoCallNearby(now: Date): boolean {
    const calendar = this.#config.meeting?.calendar;
    // Keeps the cached events fresh; they are only read while the calendar is on.
    this.currentCalendar(now);
    if (!calendar?.enabled || (calendar.policy ?? 'ask') === 'off' || !this.#calendarCache) return false;
    return suggestCalendarMeeting(this.#calendarCache.events.filter((event) => isVideoCallEvent(event)), {
      policy: calendar.policy ?? 'ask', selectedCalendars: calendar.selectedCalendars,
      leadMinutes: CALENDAR_CALL_WINDOW_MINUTES, graceMinutes: CALENDAR_CALL_WINDOW_MINUTES, now,
    }) !== undefined;
  }

  private currentCalendar(now: Date) {
    const calendar = this.#config.meeting?.calendar;
    if (!calendar?.enabled || (calendar.policy ?? 'ask') === 'off') return undefined;
    try {
      if (now.getTime() >= this.#calendarRetryAtUnixMs &&
          (!this.#calendarCache || now.getTime() - this.#calendarCache.readAtUnixMs >= 30_000) &&
          !this.#calendarRead) {
        this.#calendarRead = this.#dependencies.readCalendar({
          // Far enough either side to see a video call coming up or just ended (videoCallNearby).
          leadMinutes: Math.max(calendar.leadMinutes ?? CALENDAR_CALL_WINDOW_MINUTES, CALENDAR_CALL_WINDOW_MINUTES),
          lookbackMinutes: CALENDAR_CALL_WINDOW_MINUTES,
          signal: this.#calendarAbort.signal,
        })
          .then((events) => {
            this.#calendarCache = { readAtUnixMs: this.#dependencies.now().getTime(), events };
            this.#calendarRetryAtUnixMs = 0;
          })
          .catch((error: unknown) => {
            if (this.#shuttingDown) return;
            this.#calendarRetryAtUnixMs = this.#dependencies.now().getTime() + 5 * 60_000;
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

  private start(candidate: MeetingCandidate, now: Date): boolean {
    if (this.#active) return false;
    this.#consentId = undefined;
    const parked = this.#parked;
    const resumed = parked?.candidate.id === candidate.id && now.getTime() < parked.resumeUntilUnixMs
      ? parked : undefined;
    // A different meeting means the parked one is over; finish it first.
    if (!resumed) this.finalizeParked();
    const startedAt = resumed?.startedAt ?? now;
    if (resumed) candidate = Object.freeze({ ...resumed.candidate, pid: candidate.pid });
    let capture: DurableLiveCaptureHandle;
    let directory: string | undefined;
    let latestStatus: DurableLiveCaptureStatus | undefined;
    let record: TranscriptRecord;
    let draft: BackgroundLiveTranscriptHandle | undefined;
    let initializingDraft = true;
    const pendingDraftChunks: CommittedCaptureChunk[] = [];
    let draftWarning: string | undefined;
    const onDraftStatus = (status: BackgroundLiveTranscriptStatus) => {
      if (directory) {
        try { writeBackgroundMeetingState(directory, 'recording', { draftStatus: status }); }
        catch (error) {
          this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(),
            message: `Could not save live transcript status: ${errorMessage(error)}` });
        }
      }
      if (status.stage === 'delayed' && status.detail !== draftWarning) this.emit({ type: 'watch.warning',
        at: this.#dependencies.now().toISOString(), message: status.detail });
      draftWarning = status.stage === 'delayed' ? status.detail : undefined;
    };
    let writtenAt = -Infinity, writtenKey: string | undefined;
    let warnedKey: string | undefined;
    const onStatus = (status: DurableLiveCaptureStatus) => {
      latestStatus = status;
      const key = status.health ? captureHealthTransitionKey(status.health) : undefined;
      const at = Date.now();
      if (directory && (key !== writtenKey || at - writtenAt >= 1000)) {
        try {
          writeBackgroundMeetingState(directory, 'recording', {
            ...(status.health ? { captureHealth: status.health } : {}),
            ...(status.audioSavedThroughMs === undefined ? {} : { audioSavedThroughMs: status.audioSavedThroughMs }),
          });
          writtenKey = key; writtenAt = at;
        } catch (error) {
          this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(), message: `Could not save recording status: ${errorMessage(error)}` });
        }
      }
      const warnings = status.health ? [status.health.microphone, status.health.systemAudio]
        .flatMap(source => source.warnings.filter(w => w.resolvedAtUnixMs === undefined && w.kind !== 'unavailable')) : [];
      const warningKey = JSON.stringify(warnings.map(w => [w.kind, w.code, w.message]));
      if (warnings.length && warningKey !== warnedKey) this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(),
        message: warnings.map(w => w.message).join(' ') });
      warnedKey = warningKey;
    };
    try {
      capture = this.#dependencies.startCapture({
      libraryDir: this.#libraryDir,
      // Resuming reopens the same capture bundle on its original clock, so the
      // pause appears as a gap in one timeline instead of a second meeting.
      startedAt,
      ...(resumed ? { sessionId: resumed.capture.sessionId } : {}),
      speakerBrowser: meetBrowserMatchesApp(this.#config.meeting?.speakerBrowser, candidate.bundleId)
        ? this.#config.meeting?.speakerBrowser : 'off',
      // The call's window, or what `seashell record --video` asked for.
      video: meetingVideoRequest(this.#config, candidate),
      onStatus,
      onCommittedChunk: (chunk) => {
        if (draft) draft.enqueue(chunk);
        else if (initializingDraft) {
          // Some injected starters can commit synchronously before returning.
          // Keep only a small draft backlog; durable audio remains complete.
          if (pendingDraftChunks.length === 8) pendingDraftChunks.shift();
          pendingDraftChunks.push(chunk);
        }
      },
      onError: (error) => this.emit({
        type: 'watch.warning',
        at: this.#dependencies.now().toISOString(),
        message: error.message,
      }),
      });
    } catch (error) {
      this.#controller.reset();
      if (resumed) this.finalizeParked();
      this.emit({ type: 'watch.error', at: now.toISOString(), message: `Could not start capture: ${errorMessage(error)}` });
      return false;
    }
    if (resumed) this.#parked = undefined;
    try {
      if (resumed) {
        // Continue the live draft already shown for this meeting.
        record = findTranscriptRecord(this.#libraryDir, capture.sessionId).record;
        directory = resumed.directory;
      } else {
        record = createTranscriptRecord({ transcript: [], speakers: [] }, {
          id: capture.sessionId, now, title: candidate.title,
          source: { filename: 'Live capture session', format: 'capture-session/0.1' },
        });
        directory = saveTranscriptRecord(this.#libraryDir, record).directory;
        saveMeetingArtifact(this.#libraryDir, createMeetingArtifact(record, {
          mode: this.#config.meeting?.mode ?? 'hybrid', calendar: candidate.calendar,
        }));
      }
      writeBackgroundMeetingState(directory, 'recording', {
        ...(latestStatus?.health ? { captureHealth: latestStatus.health } : {}),
        audioSavedThroughMs: latestStatus?.audioSavedThroughMs ?? 0,
        meetingKey: candidate.id,
      });
      writtenAt = Date.now(); writtenKey = latestStatus?.health ? captureHealthTransitionKey(latestStatus.health) : undefined;
    } catch (error) {
      initializingDraft = false;
      pendingDraftChunks.length = 0;
      const stopped = capture.stop('library-start-failed').catch(() => {});
      // The reopened bundle still holds the earlier part of this meeting.
      if (resumed) {
        const reopened = capture;
        void stopped.then(() => this.enqueueFinalization({ ...resumed, capture: reopened }));
      }
      this.#controller.reset();
      this.emit({ type: 'watch.error', at: now.toISOString(), message: `Could not save meeting: ${errorMessage(error)}` });
      return false;
    }
    try {
      draft = this.#dependencies.startLiveTranscript({
        libraryDir: this.#libraryDir, record, onStatus: onDraftStatus,
        ...(capture.speakerFor ? { speakerFor: capture.speakerFor } : {}),
      });
      for (const chunk of pendingDraftChunks) draft.enqueue(chunk);
    } catch {
      onDraftStatus({ stage: 'delayed', detail: 'Live transcript could not start. Audio is saved for final transcription.', queueDepth: 0 });
    } finally { initializingDraft = false; pendingDraftChunks.length = 0; }
    this.#active = { candidate, capture, directory, startedAt, ...(draft ? { draft } : {}) };
    this.projectWatch();
    if (resumed) {
      this.emit({
        type: 'meeting.resumed',
        at: now.toISOString(),
        candidate,
        sessionId: capture.sessionId,
        pausedSeconds: Math.round((now.getTime() - resumed.parkedAtUnixMs) / 1_000),
      });
    } else {
      this.emit({
        type: 'meeting.started',
        at: now.toISOString(),
        candidate,
        sessionId: capture.sessionId,
      });
    }
    return true;
  }

  private async finish(candidate: MeetingCandidate, reason: string): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    this.#consentId = undefined;
    try {
      try { await active.capture.stop(reason); }
      finally {
        try { await active.draft?.close(); }
        catch (error) {
          this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(),
            message: `Live transcript cleanup needs attention: ${errorMessage(error)}. Final transcription will continue.` });
        }
      }
      const resumeWindowMs = (this.#config.meeting?.automation?.resumeWindowSeconds ??
        DEFAULT_MEETING_AUTOMATION.resumeWindowSeconds) * 1_000;
      const parkedAtUnixMs = this.#dependencies.now().getTime();
      const park = reason === 'signal-ended' && !this.#shuttingDown && resumeWindowMs > 0;
      if (park) {
        this.#parked = { ...active, parkedAtUnixMs, resumeUntilUnixMs: parkedAtUnixMs + resumeWindowMs };
        this.markCapture(active.directory, 'processing', { draftStatus: {
          stage: 'stopped', queueDepth: 0,
          detail: `Meeting paused. If it resumes within ${Math.round(resumeWindowMs / 60_000) || 1} min it continues here; otherwise the final transcript starts.`,
        } });
      } else this.markCapture(active.directory, 'processing');
      this.emit({
        type: 'meeting.capture-finished',
        at: this.#dependencies.now().toISOString(),
        candidate,
        sessionId: active.capture.sessionId,
      });
      if (!park) this.enqueueFinalization(active);
    } catch (error) {
      this.markCapture(active.directory, 'failed');
      this.emit({
        type: 'watch.error',
        at: this.#dependencies.now().toISOString(),
        message: `Could not stop meeting capture: ${errorMessage(error)}`,
      });
    }
    this.projectWatch();
  }

  private expireParked(now: Date): void {
    if (this.#parked && now.getTime() >= this.#parked.resumeUntilUnixMs) this.finalizeParked();
  }

  private finalizeParked(): void {
    const parked = this.#parked;
    if (!parked) return;
    this.#parked = undefined;
    this.markCapture(parked.directory, 'processing', { draftStatus: {
      stage: 'stopped', queueDepth: 0, detail: 'Live draft stopped. Preparing the final transcript.',
    } });
    this.enqueueFinalization(parked);
  }

  private enqueueFinalization(meeting: ActiveMeeting): void {
    const task = async () => this.finalize(meeting.candidate, meeting.capture);
    this.#finalizationTail = this.#finalizationTail.then(task, task).catch((error: unknown) => {
      this.markCapture(meeting.directory, 'failed');
      this.emit({
        type: 'watch.error',
        at: this.#dependencies.now().toISOString(),
        message: `Meeting ${meeting.capture.sessionId} remains recoverable: ${errorMessage(error)}`,
      });
    });
  }

  private async finalize(
    candidate: MeetingCandidate,
    capture: DurableLiveCaptureHandle,
  ): Promise<void> {
    const routing = this.#config.transcription ?? DEFAULT_TRANSCRIPTION_ROUTING;
    const canonical = selectCanonicalTranscriptionRoute(routing);
    const cloud = routing.cloud;
    // Invitees cap how many voices there are, so only an event proven to be this
    // call may: none (not meeting.json's nearest event) when it is not.
    const proven = calendarEventIsThisCall(candidate, capture.store.manifest.startedAtUnixMs);
    let record: TranscriptRecord = await this.#dependencies.finalizeCapture(capture.manifestPath, {
      title: candidate.title,
      attendees: proven ? candidate.calendar!.attendees : [],
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
    // The owner may have chosen a template, a note, or no AI while the call ran, and typed notes of their own.
    const ai = readMeetingAiSettings(this.#libraryDir, record.id);
    const ownerNotes = mergeOwnerNotes(savedOwnerNotes(saved.directory), readBundleNotes(join(saved.directory, 'capture')));
    let artifact = createMeetingArtifact(record, {
      mode: this.#config.meeting?.mode ?? 'hybrid',
      ...(candidate.calendar === undefined ? {} : { calendar: candidate.calendar }),
      maxObserverRuns: this.#config.meeting?.maxObserverRuns,
    });
    if (ai) artifact = { ...artifact, ai };
    if (ownerNotes.length) artifact = { ...artifact, ownerNotes };
    saveMeetingArtifact(this.#libraryDir, artifact);
    // Live analysis only helps while someone watches the call. After a
    // background meeting, replaying every window first would add minutes (19
    // sequential calls for a 36-minute meeting) before final notes start.
    const configuredMode = this.#config.meeting?.mode ?? artifact.mode;
    const mode = configuredMode === 'hybrid' ? 'post-session' : configuredMode;
    try {
      const observer = resolveMeetingRoute(this.#config.meeting, 'observer');
      const reconciliation = resolveMeetingRoute(this.#config.meeting, 'reconciliation');
      const hasRequiredRoutes = (mode === 'post-session' || observer) &&
        (mode === 'streaming' || reconciliation);
      if (hasRequiredRoutes && !artifact.ai?.off) {
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
    } catch (error) {
      // Enrichment is optional. Preserve its checkpoints and expose the usable
      // transcript even when context loading or the selected provider fails.
      artifact = loadMeetingArtifact(this.#libraryDir, record.id) ?? artifact;
      artifact = { ...artifact, status: 'failed', failure: errorMessage(error),
        session: { ...artifact.session, stoppedReason: 'failed' } };
      saveMeetingArtifact(this.#libraryDir, artifact);
      this.emit({
        type: 'watch.warning',
        at: this.#dependencies.now().toISOString(),
        message: `Meeting ${record.id} is saved; enrichment failed: ${errorMessage(error)}`,
      });
    }
    this.markCapture(saved.directory, 'ready');
    this.emit({
      type: 'meeting.ready',
      at: this.#dependencies.now().toISOString(),
      candidate,
      transcriptId: artifact.transcriptId,
      directory: saved.directory,
    });
  }

  private markCapture(directory: string, state: BackgroundMeetingState, options?: BackgroundMeetingStatusOptions): void {
    try { writeBackgroundMeetingState(directory, state, options); }
    catch (error) {
      this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(),
        message: `Could not update capture display: ${errorMessage(error)}` });
    }
  }

  private projectWatch(): void {
    const candidate = this.#active?.candidate ?? this.#controller.state.candidate;
    try {
      writeBackgroundWatchStatus(this.#libraryDir, {
        phase: this.#shuttingDown ? 'stopped' : this.#active ? 'recording'
          : this.#controller.state.phase === 'awaiting-consent' ? 'awaiting-consent' : 'watching',
        ...(!this.#shuttingDown && candidate ? { candidate: { id: candidate.id, title: candidate.title, appName: candidate.appName } } : {}),
        ...(this.#active ? { sessionId: this.#active.capture.sessionId } : {}),
        ...(!this.#shuttingDown && this.#controller.state.phase === 'awaiting-consent' && this.#consentId ? { consentId: this.#consentId } : {}),
        ...(this.#meetWarning ? { warning: this.#meetWarning } : {}),
      }, this.#lastNowUnixMs);
    } catch (error) {
      this.emit({ type: 'watch.warning', at: this.#dependencies.now().toISOString(), message: `Could not save background recorder status: ${errorMessage(error)}` });
    }
  }

  private emit(value: AutomaticMeetingWatchEvent): void {
    this.#onEvent?.(event(value));
  }
}

export async function runAutomaticMeetingWatch(options: AutomaticMeetingWatchOptions = {}): Promise<void> {
  const lock = acquireMeetingWatchLock(options.lockPath === undefined ? {} : { path: options.lockPath });
  if (!lock) throw new Error('Another Sea Shell meeting watcher is already running');
  // The CLI owns signals and awaits this function. Nested live/final ASR must
  // never install a competing process.exit handler that skips capture flush.
  const releaseSignalOwnership = claimManagedProcessSignalOwnership();
  let service: AutomaticMeetingWatchService | undefined;
  try {
    service = new AutomaticMeetingWatchService(options);
    options.onEvent?.(event({ type: 'watch.ready', at: new Date().toISOString() }));
    if (options.once) {
      await service.pollOnce();
      return;
    }
    const pollSeconds = options.config?.meeting?.automation?.pollSeconds ??
      DEFAULT_MEETING_AUTOMATION.pollSeconds;
    while (!options.signal?.aborted) {
      await service.pollOnce();
      const reason = service.idle ? options.restartWhen?.() : undefined;
      if (reason) {
        options.onEvent?.(event({ type: 'watch.restarting', at: new Date().toISOString(), reason }));
        break;
      }
      await sleep(pollSeconds * 1_000, undefined, { signal: options.signal }).catch(() => {});
    }
  } finally {
    try { await service?.shutdown(); }
    finally {
      try { lock.release(); } finally { releaseSignalOwnership(); }
    }
  }
}
