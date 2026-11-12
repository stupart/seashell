import { existsSync } from 'fs';

/** macOS's own tool: runs a program, and everything it starts, under a scheduling policy. */
export const TASKPOLICY = '/usr/sbin/taskpolicy';

/**
 * Where Seashell's own heavy work runs. The call's audio and the call app
 * always win the CPU: on a Mac this busy, Core Audio dropped about 13,000
 * cycles in an hour, and the person on the call hears every one.
 *
 * - `live`: live drafts, clamped to utility QoS. They stay quick enough to
 *   follow the call, but every foreground and real-time thread goes first.
 * - `background`: the final pass, speaker separation, speech detection and
 *   media preparation, at Darwin background priority (PRIO_DARWIN_BG: the
 *   lowest CPU priority, throttled disk, efficiency cores). Nobody is waiting
 *   on it while a call runs.
 */
export type InferenceLane = 'live' | 'background';

export interface InferenceCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  readonly which?: (command: string) => string | null;
}

/**
 * The command line that runs `command` in its lane. taskpolicy execs the
 * program in place, so its pid, exit code and signals are the program's own.
 * A program that cannot be found is left unwrapped, so it fails exactly as it
 * always has. SEASHELL_INFERENCE_PRIORITY=normal runs everything unwrapped,
 * for benchmarks.
 */
export function inferenceCommand(command: string, args: readonly string[], lane: InferenceLane,
  options: InferenceCommandOptions = {}): { command: string; args: string[] } {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((name: string) => Bun.which(name));
  const found = command.includes('/') ? exists(command) : which(command) !== null;
  if ((options.platform ?? process.platform) !== 'darwin' || env.SEASHELL_INFERENCE_PRIORITY === 'normal' ||
      !exists(TASKPOLICY) || !found) return { command, args: [...args] };
  return { command: TASKPOLICY, args: [...(lane === 'live' ? ['-c', 'utility'] : ['-b']), command, ...args] };
}
