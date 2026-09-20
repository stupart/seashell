# Start the live clock when recording begins

A TUI left idle before its first recording used the application startup time
as the audio clock origin. An observed 39-second manual capture therefore
started at 9,267 seconds in its saved timeline. Finalization filled that idle
period with silence, inflating both the reported duration and the work required
to transcribe the assembled audio.

The clock now starts once, immediately before the first source opens. Both
tracks share that origin. Pausing and resuming an existing recording preserves
its timeline, while clearing a session defers the next clock until capture
actually resumes. The record creation time and default title also reflect
recording startup. Automatic meetings establish the clock before saving their
initial transcript and meeting artifact.

Two isolated Ink integration tests reproduce manual recording and browser
meeting approval after two simulated idle hours. They failed before the fix
with the two-hour offset. They now pass, also verifying the shared source
clock, a pause/resume, and another four idle hours after clearing a paused
session. No microphone, real watcher, ASR service, or user library is used by
these tests.

The full native/storage/meeting gym passed: 181 Bun tests, 3 Python tests,
typechecking, native build, accelerated capture storage, and 100 meeting
lifecycle cycles. Evidence is in this worktree's `.gym-results/` directory.
Existing recordings are preserved; this change applies to new capture sessions.
