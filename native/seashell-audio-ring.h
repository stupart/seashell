#ifndef SEASHELL_AUDIO_RING_H
#define SEASHELL_AUDIO_RING_H
// The audio handoff both capture helpers share (seashell-audio-ring.c).
//
// The ring moves audio from the thread that receives it to the thread that
// converts and writes it. Its producer functions are real-time safe: no locks,
// no allocation, no system calls, no Objective-C or Swift runtime, and no loop
// longer than one record. A producer that finds no room counts the frames as
// dropped and returns; it never waits for the consumer.
//
// The PCM pipe writes the converted stream to stdout without ever waiting for
// the reader. What does not fit is replaced by as much silence, written once
// the reader catches up, so the stream keeps its length and every sample its
// place on the meeting's timeline.
#include <CoreAudio/CoreAudio.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct seashell_audio_ring seashell_audio_ring;

/** One stored packet's description, read by the consumer before its audio. */
typedef struct {
    /** Frames the producer could not store between the previous packet and this one. */
    uint64_t droppedFramesBefore;
    /** mach_absolute_time() when the producer stored it. */
    uint64_t storedHostTime;
    /** The device's time for the first frame, valid when timeFlags says so. */
    uint64_t hostTime;
    double sampleTime;
    uint32_t timeFlags;
    uint32_t frames;
    uint32_t bufferCount;
    uint32_t bytesPerBuffer;
    /** The format the frames are in. */
    AudioStreamBasicDescription format;
} seashell_audio_record;

/** Room for at least `seconds` of `format` in packets of 128 frames or more,
 * up to `maximumBytes`. Allocates, touches and wires every page, so call it
 * before audio starts and never on an audio thread. NULL when memory is short. */
seashell_audio_ring *seashell_audio_ring_create(const AudioStreamBasicDescription *format, double seconds, size_t maximumBytes);
void seashell_audio_ring_destroy(seashell_audio_ring *ring);
size_t seashell_audio_ring_capacity(seashell_audio_ring *ring);

// Producer: one thread at a time.

/** Copies every buffer of the list, or counts its frames as dropped. */
bool seashell_audio_ring_write(seashell_audio_ring *ring, const AudioBufferList *buffers, uint32_t frames,
                               const AudioTimeStamp *time, const AudioStreamBasicDescription *format);
/** The IO block's whole body: frames from the byte count, in the ring's own format. */
bool seashell_audio_ring_write_device(seashell_audio_ring *ring, const AudioBufferList *buffers, const AudioTimeStamp *time);
/** Registers an IO block that does nothing but seashell_audio_ring_write_device,
 * invoked directly on the device's IO thread. */
OSStatus seashell_audio_ring_create_ioproc(seashell_audio_ring *ring, AudioObjectID device, AudioDeviceIOProcID *ioProcID);

// Consumer: one thread at a time.

/** The next packet's description; false when the ring is empty. */
bool seashell_audio_ring_peek(seashell_audio_ring *ring, seashell_audio_record *record);
/** Copies the peeked packet into `buffers` (bufferCount buffers whose
 * mDataByteSize is at least bytesPerBuffer) and frees its room. Frees it and
 * returns false when they do not fit. */
bool seashell_audio_ring_read(seashell_audio_ring *ring, const seashell_audio_record *record, AudioBufferList *buffers);
/** Frames dropped after the last stored packet. Only while the producer is stopped. */
uint64_t seashell_audio_ring_take_trailing_drops(seashell_audio_ring *ring);
/** Frames dropped since creation. Any thread. */
uint64_t seashell_audio_ring_dropped_frames(seashell_audio_ring *ring);

typedef struct seashell_pcm_pipe seashell_pcm_pipe;

/** Writes to `fd`, holding up to `capacity` bytes while its reader is away. A
 * pipe or socket is made non-blocking unless stderr shares it; a terminal or
 * file keeps blocking writes, which never fill. */
seashell_pcm_pipe *seashell_pcm_pipe_create(int fd, size_t capacity);
/** The same, with room for `marks` separate stretches of silence (the self-tests use few). */
seashell_pcm_pipe *seashell_pcm_pipe_create_with_marks(int fd, size_t capacity, size_t marks);
void seashell_pcm_pipe_destroy(seashell_pcm_pipe *pipe);
/** Writes can never wait for the reader. */
bool seashell_pcm_pipe_nonblocking(seashell_pcm_pipe *pipe);
/** Queues bytes, or replaces all of them with silence when they do not fit.
 * Returns how many bytes were replaced: 0 or `count`. */
size_t seashell_pcm_pipe_append(seashell_pcm_pipe *pipe, const void *bytes, size_t count);
/** Queues silence. Costs no room. */
void seashell_pcm_pipe_append_zeros(seashell_pcm_pipe *pipe, uint64_t count);
/** Writes what the reader takes now, without waiting. 0, or -1 once the reader is gone. */
int seashell_pcm_pipe_flush(seashell_pcm_pipe *pipe);
/** Writes everything, waiting at most `timeoutMs` for the reader. 0 when all
 * was written, 1 when time ran out, -1 when the reader is gone. */
int seashell_pcm_pipe_drain(seashell_pcm_pipe *pipe, int timeoutMs);
/** Bytes, silence included, not yet written. */
uint64_t seashell_pcm_pipe_pending(seashell_pcm_pipe *pipe);
/** Bytes of queued audio turned into silence because the pipe ran out of marks. */
uint64_t seashell_pcm_pipe_silenced(seashell_pcm_pipe *pipe);

// Self-tests: synthetic packets, no audio device.

typedef struct {
    /** The producer thread got the time-constraint policy audio IO threads run with. */
    bool realtime;
    /** Seconds of audio the ring held while nothing read it. */
    double ringSeconds;
    uint64_t pushedFrames;
    uint64_t storedFrames;
    uint64_t droppedFrames;
    /** What the ring itself counted. */
    uint64_t countedDrops;
    double maxWriteMicroseconds;
    /** The producer finished while the consumer was stalled: it never waited. */
    bool producerFinished;
    /** Every frame came out once, in order, with a gap exactly where frames were dropped. */
    bool orderKept;
    /** The same, with producer and consumer running at once. */
    uint64_t concurrentPackets;
    uint64_t concurrentDroppedFrames;
    bool concurrentOrderKept;
} seashell_ring_check;

/** Pushes packets of `framesPerBuffer` frames shaped like `format` (Float32,
 * each value its frame index) from a time-constraint thread while nothing
 * reads, then reads them back; then again with both running. `device` pushes
 * through seashell_audio_ring_write_device, the IO block's body. */
bool seashell_ring_check_run(const AudioStreamBasicDescription *format, uint32_t framesPerBuffer, bool device, seashell_ring_check *result);

typedef struct {
    bool nonblocking;
    uint64_t bytes;
    uint64_t replacedBytes;
    double maxAppendMicroseconds;
    /** Every append returned while nothing read the pipe. */
    bool writerFinished;
    /** What came out is as long as what went in. */
    bool lengthKept;
    /** Every byte is the one written there, or silence where it was replaced. */
    bool orderKept;
    /** Out of marks, queued audio turns to silence in place: nothing moves. */
    bool marksExhaustedInPlace;
    /** Closing the read end is reported, and does not kill the process. */
    bool readerGoneDetected;
} seashell_pipe_check;

bool seashell_pipe_check_run(size_t capacity, size_t chunk, seashell_pipe_check *result);

#endif
