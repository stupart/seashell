#include "seashell-audio-ring.h"
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

_Static_assert(ATOMIC_LLONG_LOCK_FREE == 2, "the audio thread needs lock-free 64-bit atomics");

// Apple silicon's cache line. The two positions sit on separate lines so the
// producer and consumer never contend for one.
#define CACHE_LINE 128
#define MAX_BUFFERS 64
#define MIN_RING_BYTES ((uint64_t)1 << 20)

struct seashell_audio_ring {
    /** Bytes ever stored. Written by the producer only. */
    _Alignas(CACHE_LINE) _Atomic uint64_t write_position;
    /** Bytes ever freed. Written by the consumer only. */
    _Alignas(CACHE_LINE) _Atomic uint64_t read_position;
    /** Frames dropped since the last stored packet, handed to the next one. */
    _Alignas(CACHE_LINE) _Atomic uint64_t pending_drops;
    _Atomic uint64_t dropped_frames;
    _Alignas(CACHE_LINE) uint8_t *bytes;
    /** A power of two. */
    uint64_t capacity;
    uint64_t mask;
    uint32_t bytes_per_frame;
    AudioStreamBasicDescription format;
    bool wired;
};

static uint64_t record_bytes(uint32_t buffers, uint32_t bytesPerBuffer) {
    uint64_t bytes = sizeof(seashell_audio_record) + (uint64_t)buffers * bytesPerBuffer;
    return (bytes + 15) & ~(uint64_t)15;
}

seashell_audio_ring *seashell_audio_ring_create(const AudioStreamBasicDescription *format, double seconds, size_t maximumBytes) {
    if (format == NULL || !(format->mSampleRate > 0) || format->mBytesPerFrame == 0 || !(seconds > 0)) return NULL;
    uint32_t buffers = (format->mFormatFlags & kAudioFormatFlagIsNonInterleaved) ? format->mChannelsPerFrame : 1;
    if (buffers == 0 || buffers > MAX_BUFFERS) return NULL;
    // Audio plus one description per packet of 128 frames, the smallest IO size in common use.
    double perSecond = format->mSampleRate * format->mBytesPerFrame * buffers +
        format->mSampleRate / 128.0 * (double)record_bytes(0, 0);
    uint64_t capacity = MIN_RING_BYTES;
    while ((double)capacity < perSecond * seconds && capacity < ((uint64_t)1 << 32)) capacity <<= 1;
    while (capacity > maximumBytes && capacity > MIN_RING_BYTES) capacity >>= 1;
    seashell_audio_ring *ring = aligned_alloc(CACHE_LINE, sizeof(seashell_audio_ring));
    if (ring == NULL) return NULL;
    memset(ring, 0, sizeof *ring);
    atomic_init(&ring->write_position, 0);
    atomic_init(&ring->read_position, 0);
    atomic_init(&ring->pending_drops, 0);
    atomic_init(&ring->dropped_frames, 0);
    ring->bytes = malloc((size_t)capacity);
    if (ring->bytes == NULL) { free(ring); return NULL; }
    // Touch every page now: a first touch on the audio thread would fault. Then
    // keep them resident, since a compressed or paged-out page faults as well.
    // Wiring is best effort; the pages are touched either way.
    memset(ring->bytes, 0, (size_t)capacity);
    ring->wired = mlock(ring->bytes, (size_t)capacity) == 0;
    ring->capacity = capacity;
    ring->mask = capacity - 1;
    ring->bytes_per_frame = format->mBytesPerFrame;
    ring->format = *format;
    return ring;
}

void seashell_audio_ring_destroy(seashell_audio_ring *ring) {
    if (ring == NULL) return;
    if (ring->wired) munlock(ring->bytes, (size_t)ring->capacity);
    free(ring->bytes);
    free(ring);
}

size_t seashell_audio_ring_capacity(seashell_audio_ring *ring) {
    return ring == NULL ? 0 : (size_t)ring->capacity;
}

static void copy_in(seashell_audio_ring *ring, uint64_t position, const void *source, size_t count) {
    size_t offset = (size_t)(position & ring->mask);
    size_t first = (size_t)ring->capacity - offset;
    if (count <= first) { memcpy(ring->bytes + offset, source, count); return; }
    memcpy(ring->bytes + offset, source, first);
    memcpy(ring->bytes, (const uint8_t *)source + first, count - first);
}

static void copy_out(seashell_audio_ring *ring, uint64_t position, void *destination, size_t count) {
    size_t offset = (size_t)(position & ring->mask);
    size_t first = (size_t)ring->capacity - offset;
    if (count <= first) { memcpy(destination, ring->bytes + offset, count); return; }
    memcpy(destination, ring->bytes + offset, first);
    memcpy((uint8_t *)destination + first, ring->bytes, count - first);
}

bool seashell_audio_ring_write(seashell_audio_ring *ring, const AudioBufferList *buffers, uint32_t frames,
                               const AudioTimeStamp *time, const AudioStreamBasicDescription *format) {
    if (ring == NULL) return false;
    if (frames == 0) return true;
    uint32_t count = buffers != NULL ? buffers->mNumberBuffers : 0;
    uint32_t bytes = count > 0 ? buffers->mBuffers[0].mDataByteSize : 0;
    bool valid = count > 0 && count <= MAX_BUFFERS && bytes > 0;
    if (valid && format != NULL && format->mBytesPerFrame > 0) valid = (uint64_t)frames * format->mBytesPerFrame == bytes;
    for (uint32_t index = 0; valid && index < count; index++) {
        valid = buffers->mBuffers[index].mData != NULL && buffers->mBuffers[index].mDataByteSize == bytes;
    }
    uint64_t need = valid ? record_bytes(count, bytes) : 0;
    uint64_t write = atomic_load_explicit(&ring->write_position, memory_order_relaxed);
    // Acquire: the consumer has finished copying out every byte it freed.
    uint64_t read = atomic_load_explicit(&ring->read_position, memory_order_acquire);
    if (!valid || need > ring->capacity - (write - read)) {
        atomic_fetch_add_explicit(&ring->pending_drops, frames, memory_order_relaxed);
        atomic_fetch_add_explicit(&ring->dropped_frames, frames, memory_order_relaxed);
        return false;
    }
    seashell_audio_record record;
    memset(&record, 0, sizeof record);
    record.droppedFramesBefore = atomic_exchange_explicit(&ring->pending_drops, 0, memory_order_relaxed);
    // A commpage read on macOS, not a system call.
    record.storedHostTime = mach_absolute_time();
    if (time != NULL) {
        record.hostTime = time->mHostTime;
        record.sampleTime = time->mSampleTime;
        record.timeFlags = time->mFlags;
    }
    record.frames = frames;
    record.bufferCount = count;
    record.bytesPerBuffer = bytes;
    record.format = format != NULL ? *format : ring->format;
    copy_in(ring, write, &record, sizeof record);
    uint64_t position = write + sizeof record;
    for (uint32_t index = 0; index < count; index++) {
        copy_in(ring, position, buffers->mBuffers[index].mData, bytes);
        position += bytes;
    }
    // Release: the packet is complete before the consumer can see it.
    atomic_store_explicit(&ring->write_position, write + need, memory_order_release);
    return true;
}

bool seashell_audio_ring_write_device(seashell_audio_ring *ring, const AudioBufferList *buffers, const AudioTimeStamp *time) {
    if (ring == NULL) return false;
    uint32_t bytes = buffers != NULL && buffers->mNumberBuffers > 0 ? buffers->mBuffers[0].mDataByteSize : 0;
    return seashell_audio_ring_write(ring, buffers, bytes / ring->bytes_per_frame, time, &ring->format);
}

OSStatus seashell_audio_ring_create_ioproc(seashell_audio_ring *ring, AudioObjectID device, AudioDeviceIOProcID *ioProcID) {
    // No dispatch queue. CoreAudio/AudioHardware.h, AudioDeviceCreateIOProcIDWithBlock:
    // "All IOBlocks are dispatched synchronously ... If this value is NULL, then
    // the IOBlock will be directly invoked." With a queue, the device's IO thread
    // would wait inside its IO cycle for a GCD hop and that queue's scheduling;
    // without one, the block runs on the IO thread itself and only copies.
    // It captures nothing but the ring's address: no Objective-C or Swift object.
    return AudioDeviceCreateIOProcIDWithBlock(ioProcID, device, NULL,
        ^(const AudioTimeStamp *now, const AudioBufferList *input, const AudioTimeStamp *inputTime,
          AudioBufferList *output, const AudioTimeStamp *outputTime) {
            (void)now; (void)output; (void)outputTime;
            seashell_audio_ring_write_device(ring, input, inputTime);
        });
}

bool seashell_audio_ring_peek(seashell_audio_ring *ring, seashell_audio_record *record) {
    if (ring == NULL || record == NULL) return false;
    uint64_t read = atomic_load_explicit(&ring->read_position, memory_order_relaxed);
    // Acquire: pairs with the producer's release, so the whole packet is visible.
    uint64_t write = atomic_load_explicit(&ring->write_position, memory_order_acquire);
    if (write == read) return false;
    copy_out(ring, read, record, sizeof *record);
    return true;
}

bool seashell_audio_ring_read(seashell_audio_ring *ring, const seashell_audio_record *record, AudioBufferList *buffers) {
    if (ring == NULL || record == NULL) return false;
    uint64_t read = atomic_load_explicit(&ring->read_position, memory_order_relaxed);
    bool fits = buffers != NULL && buffers->mNumberBuffers == record->bufferCount;
    for (uint32_t index = 0; fits && index < record->bufferCount; index++) {
        fits = buffers->mBuffers[index].mData != NULL && buffers->mBuffers[index].mDataByteSize >= record->bytesPerBuffer;
    }
    if (fits) {
        uint64_t position = read + sizeof *record;
        for (uint32_t index = 0; index < record->bufferCount; index++) {
            copy_out(ring, position, buffers->mBuffers[index].mData, record->bytesPerBuffer);
            buffers->mBuffers[index].mDataByteSize = record->bytesPerBuffer;
            position += record->bytesPerBuffer;
        }
    }
    // Release: the copy is done before the producer may overwrite these bytes.
    atomic_store_explicit(&ring->read_position, read + record_bytes(record->bufferCount, record->bytesPerBuffer),
        memory_order_release);
    return fits;
}

uint64_t seashell_audio_ring_take_trailing_drops(seashell_audio_ring *ring) {
    return ring == NULL ? 0 : atomic_exchange_explicit(&ring->pending_drops, 0, memory_order_acq_rel);
}

uint64_t seashell_audio_ring_dropped_frames(seashell_audio_ring *ring) {
    return ring == NULL ? 0 : atomic_load_explicit(&ring->dropped_frames, memory_order_relaxed);
}

// MARK: - PCM pipe

typedef struct {
    /** Where in the audio the silence goes: after this many queued audio bytes. */
    uint64_t at;
    uint64_t zeros;
} silence_mark;

struct seashell_pcm_pipe {
    int fd;
    bool nonblocking;
    bool closed;
    uint8_t *bytes;
    uint64_t capacity;
    /** Audio bytes written out. */
    uint64_t head;
    /** Audio bytes queued. */
    uint64_t tail;
    silence_mark *marks;
    size_t mark_capacity;
    size_t first_mark;
    size_t mark_count;
    /** Silence queued and not yet written. */
    uint64_t zeros;
    uint64_t silenced;
};

static const uint8_t silence_block[16384];

seashell_pcm_pipe *seashell_pcm_pipe_create_with_marks(int fd, size_t capacity, size_t marks) {
    if (capacity == 0) return NULL;
    seashell_pcm_pipe *pipe = calloc(1, sizeof(seashell_pcm_pipe));
    if (pipe == NULL) return NULL;
    pipe->fd = fd;
    pipe->capacity = capacity;
    pipe->mark_capacity = marks > 0 ? marks : 1;
    pipe->bytes = malloc(capacity);
    pipe->marks = calloc(pipe->mark_capacity, sizeof(silence_mark));
    if (pipe->bytes == NULL || pipe->marks == NULL) { seashell_pcm_pipe_destroy(pipe); return NULL; }
    struct stat output, error;
    bool stream = fstat(fd, &output) == 0 && (S_ISFIFO(output.st_mode) || S_ISSOCK(output.st_mode));
    // O_NONBLOCK belongs to the open file, not the descriptor: on a pipe stderr
    // shares, it would make the event writes fail too. Such a run is a person's
    // terminal command, not the recorder, which gives each stream its own pipe.
    bool shared = fd != STDERR_FILENO && fstat(STDERR_FILENO, &error) == 0 &&
        error.st_dev == output.st_dev && error.st_ino == output.st_ino;
    if (stream && !shared && fd != STDERR_FILENO) {
        int flags = fcntl(fd, F_GETFL);
        pipe->nonblocking = flags != -1 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
    }
    return pipe;
}

seashell_pcm_pipe *seashell_pcm_pipe_create(int fd, size_t capacity) {
    return seashell_pcm_pipe_create_with_marks(fd, capacity, 4096);
}

void seashell_pcm_pipe_destroy(seashell_pcm_pipe *pipe) {
    if (pipe == NULL) return;
    free(pipe->bytes);
    free(pipe->marks);
    free(pipe);
}

bool seashell_pcm_pipe_nonblocking(seashell_pcm_pipe *pipe) { return pipe != NULL && pipe->nonblocking; }

static silence_mark *mark_at(seashell_pcm_pipe *pipe, size_t index) {
    return &pipe->marks[(pipe->first_mark + index) % pipe->mark_capacity];
}

static void owe_silence(seashell_pcm_pipe *pipe, uint64_t count) {
    pipe->zeros += count;
    if (pipe->mark_count > 0) {
        silence_mark *last = mark_at(pipe, pipe->mark_count - 1);
        if (last->at == pipe->tail) { last->zeros += count; return; }
        if (pipe->mark_count == pipe->mark_capacity) {
            // No mark left for another stretch: the audio queued after the last
            // one becomes silence as well, so nothing after it moves.
            uint64_t queued = pipe->tail - last->at;
            pipe->tail = last->at;
            last->zeros += queued + count;
            pipe->zeros += queued;
            pipe->silenced += queued;
            return;
        }
    }
    *mark_at(pipe, pipe->mark_count) = (silence_mark){ .at = pipe->tail, .zeros = count };
    pipe->mark_count++;
}

size_t seashell_pcm_pipe_append(seashell_pcm_pipe *pipe, const void *bytes, size_t count) {
    if (pipe == NULL || pipe->closed || count == 0) return 0;
    if (count <= pipe->capacity - (pipe->tail - pipe->head)) {
        size_t offset = (size_t)(pipe->tail % pipe->capacity);
        size_t first = (size_t)pipe->capacity - offset;
        if (count <= first) memcpy(pipe->bytes + offset, bytes, count);
        else {
            memcpy(pipe->bytes + offset, bytes, first);
            memcpy(pipe->bytes, (const uint8_t *)bytes + first, count - first);
        }
        pipe->tail += count;
        return 0;
    }
    owe_silence(pipe, count);
    return count;
}

void seashell_pcm_pipe_append_zeros(seashell_pcm_pipe *pipe, uint64_t count) {
    if (pipe == NULL || pipe->closed || count == 0) return;
    owe_silence(pipe, count);
}

int seashell_pcm_pipe_flush(seashell_pcm_pipe *pipe) {
    if (pipe == NULL || pipe->closed) return -1;
    while (true) {
        silence_mark *mark = pipe->mark_count > 0 ? mark_at(pipe, 0) : NULL;
        const void *source;
        size_t length;
        if (mark != NULL && mark->at == pipe->head) {
            if (mark->zeros == 0) {
                pipe->first_mark = (pipe->first_mark + 1) % pipe->mark_capacity;
                pipe->mark_count--;
                continue;
            }
            source = silence_block;
            length = mark->zeros < sizeof silence_block ? (size_t)mark->zeros : sizeof silence_block;
        } else if (pipe->head < pipe->tail) {
            uint64_t limit = mark != NULL ? mark->at : pipe->tail;
            size_t offset = (size_t)(pipe->head % pipe->capacity);
            uint64_t contiguous = pipe->capacity - offset;
            length = (size_t)(limit - pipe->head < contiguous ? limit - pipe->head : contiguous);
            source = pipe->bytes + offset;
        } else return 0;
        ssize_t written = write(pipe->fd, source, length);
        if (written < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN) return 0;
            pipe->closed = true;
            return -1;
        }
        if (written == 0) return 0;
        if (source == silence_block) {
            mark->zeros -= (uint64_t)written;
            pipe->zeros -= (uint64_t)written;
        } else pipe->head += (uint64_t)written;
    }
}

static int64_t monotonic_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int seashell_pcm_pipe_drain(seashell_pcm_pipe *pipe, int timeoutMs) {
    int64_t deadline = monotonic_ms() + (timeoutMs > 0 ? timeoutMs : 0);
    while (true) {
        if (seashell_pcm_pipe_flush(pipe) < 0) return -1;
        if (seashell_pcm_pipe_pending(pipe) == 0) return 0;
        int64_t remaining = deadline - monotonic_ms();
        if (remaining <= 0) return 1;
        struct pollfd poller = { .fd = pipe->fd, .events = POLLOUT };
        if (poll(&poller, 1, (int)remaining) < 0 && errno != EINTR) return 1;
    }
}

uint64_t seashell_pcm_pipe_pending(seashell_pcm_pipe *pipe) {
    return pipe == NULL ? 0 : (pipe->tail - pipe->head) + pipe->zeros;
}

uint64_t seashell_pcm_pipe_silenced(seashell_pcm_pipe *pipe) { return pipe == NULL ? 0 : pipe->silenced; }

// MARK: - Self-tests

static double ticks_to_microseconds(uint64_t ticks) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    return (double)ticks * timebase.numer / timebase.denom / 1000.0;
}

/** The scheduling a HAL IO thread runs with: a period, a budget, and a deadline. */
static bool make_realtime(double periodSeconds) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    uint32_t period = (uint32_t)(periodSeconds * 1e9 * timebase.denom / timebase.numer);
    thread_time_constraint_policy_data_t policy = {
        .period = period, .computation = period / 2, .constraint = period, .preemptible = TRUE,
    };
    return thread_policy_set(pthread_mach_thread_np(pthread_self()), THREAD_TIME_CONSTRAINT_POLICY,
        (thread_policy_t)&policy, THREAD_TIME_CONSTRAINT_POLICY_COUNT) == KERN_SUCCESS;
}

typedef struct {
    AudioStreamBasicDescription format;
    uint32_t frames;
    uint32_t buffers;
    uint32_t channelsPerBuffer;
    AudioBufferList *list;
} packet_shape;

static bool shape_init(packet_shape *shape, const AudioStreamBasicDescription *format, uint32_t frames) {
    bool planar = (format->mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    shape->format = *format;
    shape->frames = frames;
    shape->buffers = planar ? format->mChannelsPerFrame : 1;
    shape->channelsPerBuffer = planar ? 1 : format->mChannelsPerFrame;
    if (shape->buffers == 0 || shape->buffers > MAX_BUFFERS || format->mBytesPerFrame != 4 * shape->channelsPerBuffer) return false;
    shape->list = calloc(1, offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer) * shape->buffers);
    if (shape->list == NULL) return false;
    shape->list->mNumberBuffers = shape->buffers;
    for (uint32_t index = 0; index < shape->buffers; index++) {
        shape->list->mBuffers[index].mNumberChannels = shape->channelsPerBuffer;
        shape->list->mBuffers[index].mDataByteSize = frames * format->mBytesPerFrame;
        shape->list->mBuffers[index].mData = calloc(frames, format->mBytesPerFrame);
        if (shape->list->mBuffers[index].mData == NULL) return false;
    }
    return true;
}

static void shape_free(packet_shape *shape) {
    if (shape->list == NULL) return;
    for (uint32_t index = 0; index < shape->list->mNumberBuffers; index++) free(shape->list->mBuffers[index].mData);
    free(shape->list);
    shape->list = NULL;
}

/** Exact in Float32: a frame index below 2^21, plus 2^21 per channel up to 8. */
static float sample_value(uint64_t frame, uint32_t channel) {
    return (float)(frame % 2097152) + (float)(channel % 8) * 2097152.0f;
}

static void shape_fill(packet_shape *shape, uint64_t first) {
    for (uint32_t buffer = 0; buffer < shape->buffers; buffer++) {
        float *samples = shape->list->mBuffers[buffer].mData;
        shape->list->mBuffers[buffer].mDataByteSize = shape->frames * shape->format.mBytesPerFrame;
        for (uint32_t frame = 0; frame < shape->frames; frame++) {
            for (uint32_t channel = 0; channel < shape->channelsPerBuffer; channel++) {
                samples[frame * shape->channelsPerBuffer + channel] = sample_value(first + frame, buffer + channel);
            }
        }
    }
}

typedef struct {
    seashell_audio_ring *ring;
    packet_shape shape;
    uint64_t firstFrame;
    uint64_t packets;
    /** Ticks between packets; 0 pushes as fast as it can. */
    uint64_t spacing;
    bool device;
    bool realtime;
    uint64_t stored;
    uint64_t dropped;
    uint64_t maxTicks;
    dispatch_semaphore_t done;
} producer_job;

static void *produce(void *argument) {
    producer_job *job = argument;
    job->realtime = make_realtime(job->shape.frames / job->shape.format.mSampleRate);
    AudioTimeStamp time;
    memset(&time, 0, sizeof time);
    time.mFlags = kAudioTimeStampSampleTimeValid | kAudioTimeStampHostTimeValid;
    uint64_t began = mach_absolute_time();
    for (uint64_t packet = 0; packet < job->packets; packet++) {
        if (job->spacing > 0) while (mach_absolute_time() - began < packet * job->spacing) {}
        uint64_t first = job->firstFrame + packet * job->shape.frames;
        shape_fill(&job->shape, first);
        time.mSampleTime = (double)first;
        time.mHostTime = mach_absolute_time();
        uint64_t start = mach_absolute_time();
        bool stored = job->device
            ? seashell_audio_ring_write_device(job->ring, job->shape.list, &time)
            : seashell_audio_ring_write(job->ring, job->shape.list, job->shape.frames, &time, &job->shape.format);
        uint64_t elapsed = mach_absolute_time() - start;
        if (elapsed > job->maxTicks) job->maxTicks = elapsed;
        if (stored) job->stored += job->shape.frames;
        else job->dropped += job->shape.frames;
    }
    dispatch_semaphore_signal(job->done);
    return NULL;
}

/** Runs `job` on its own thread. False when it has not finished within the timeout: it waited. */
static bool run_producer(producer_job *job, double timeoutSeconds, pthread_t *thread) {
    job->done = dispatch_semaphore_create(0);
    if (pthread_create(thread, NULL, produce, job) != 0) return false;
    return dispatch_semaphore_wait(job->done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * 1e9))) == 0;
}

typedef struct {
    packet_shape scratch;
    uint64_t next;
    uint64_t packets;
    uint64_t dropped;
    bool ok;
} reader_state;

/** Reads one packet and checks it starts where the last ended, plus what was dropped between. */
static bool read_and_check(seashell_audio_ring *ring, reader_state *reader) {
    seashell_audio_record record;
    if (!seashell_audio_ring_peek(ring, &record)) return false;
    packet_shape *scratch = &reader->scratch;
    for (uint32_t index = 0; index < scratch->buffers; index++) {
        scratch->list->mBuffers[index].mDataByteSize = scratch->frames * scratch->format.mBytesPerFrame;
    }
    bool fits = seashell_audio_ring_read(ring, &record, scratch->list);
    reader->next += record.droppedFramesBefore;
    reader->dropped += record.droppedFramesBefore;
    if (!fits || record.frames != scratch->frames || record.bufferCount != scratch->buffers ||
        (uint64_t)record.sampleTime != reader->next || (record.timeFlags & kAudioTimeStampSampleTimeValid) == 0) {
        reader->ok = false;
    } else {
        for (uint32_t buffer = 0; buffer < scratch->buffers && reader->ok; buffer++) {
            const float *samples = scratch->list->mBuffers[buffer].mData;
            for (uint32_t frame = 0; frame < record.frames && reader->ok; frame++) {
                for (uint32_t channel = 0; channel < scratch->channelsPerBuffer; channel++) {
                    if (samples[frame * scratch->channelsPerBuffer + channel] != sample_value(reader->next + frame, buffer + channel)) {
                        reader->ok = false;
                    }
                }
            }
        }
    }
    reader->next += record.frames;
    reader->packets++;
    return true;
}

bool seashell_ring_check_run(const AudioStreamBasicDescription *format, uint32_t framesPerBuffer, bool device, seashell_ring_check *result) {
    memset(result, 0, sizeof *result);
    if (format == NULL || framesPerBuffer == 0) return false;
    // On the heap: a producer that never finishes keeps using them, so a failed check leaks them rather than free them.
    producer_job *job = calloc(3, sizeof(producer_job));
    reader_state reader;
    memset(&reader, 0, sizeof reader);
    reader.ok = true;
    seashell_audio_ring *ring = seashell_audio_ring_create(format, 6, 32u << 20);
    if (job == NULL || ring == NULL || !shape_init(&job[0].shape, format, framesPerBuffer) ||
        !shape_init(&reader.scratch, format, framesPerBuffer)) return false;
    uint64_t packetBytes = record_bytes(job[0].shape.buffers, framesPerBuffer * format->mBytesPerFrame);
    // 1. Nothing reads: half again as many packets as the ring holds.
    job[0].ring = ring;
    job[0].device = device;
    job[0].packets = seashell_audio_ring_capacity(ring) / packetBytes * 3 / 2 + 64;
    pthread_t thread;
    result->producerFinished = run_producer(&job[0], 10, &thread);
    if (!result->producerFinished) return false;
    pthread_join(thread, NULL);
    result->realtime = job[0].realtime;
    result->pushedFrames = job[0].stored + job[0].dropped;
    result->storedFrames = job[0].stored;
    result->droppedFrames = job[0].dropped;
    result->ringSeconds = (double)job[0].stored / format->mSampleRate;
    uint64_t maxTicks = job[0].maxTicks;
    // 2. The consumer wakes and reads it all back, in order.
    while (read_and_check(ring, &reader)) {}
    bool firstInOrder = reader.ok && reader.next == job[0].stored && reader.dropped == 0;
    // 3. The producer stores again: the first new packet carries the drops, placed where they happened.
    uint64_t pushed = job[0].stored + job[0].dropped;
    job[1].ring = ring;
    job[1].device = device;
    job[1].shape = job[0].shape;
    job[1].firstFrame = pushed;
    job[1].packets = 16;
    result->producerFinished = run_producer(&job[1], 10, &thread);
    if (!result->producerFinished) return false;
    pthread_join(thread, NULL);
    if (job[1].maxTicks > maxTicks) maxTicks = job[1].maxTicks;
    pushed += job[1].stored + job[1].dropped;
    while (read_and_check(ring, &reader)) {}
    uint64_t trailing = seashell_audio_ring_take_trailing_drops(ring);
    result->countedDrops = seashell_audio_ring_dropped_frames(ring);
    result->orderKept = firstInOrder && reader.ok && job[1].dropped == 0 && trailing == 0 &&
        reader.dropped == job[0].dropped && reader.next == pushed && result->countedDrops == job[0].dropped;
    result->maxWriteMicroseconds = ticks_to_microseconds(maxTicks);
    seashell_audio_ring_destroy(ring);

    // 4. Both at once: a paced producer and a consumer that stalls now and then.
    ring = seashell_audio_ring_create(format, 6, 32u << 20);
    if (ring == NULL) return false;
    reader.next = 0; reader.packets = 0; reader.dropped = 0; reader.ok = true;
    job[2].ring = ring;
    job[2].device = device;
    job[2].shape = job[0].shape;
    job[2].packets = framesPerBuffer >= 10240 ? 2000 : 20480000 / framesPerBuffer;
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    job[2].spacing = (uint64_t)(5000.0 * timebase.denom / timebase.numer); // 5 µs
    job[2].done = dispatch_semaphore_create(0);
    if (pthread_create(&thread, NULL, produce, &job[2]) != 0) return false;
    unsigned int seed = 7;
    bool finished = false;
    int64_t deadline = monotonic_ms() + 60000;
    while (true) {
        if (!finished) finished = dispatch_semaphore_wait(job[2].done, DISPATCH_TIME_NOW) == 0;
        bool read = read_and_check(ring, &reader);
        if (!read && finished) break;
        if (monotonic_ms() > deadline) return false;
        if (read && reader.packets % 256 == 0) usleep((useconds_t)(rand_r(&seed) % 8000));
    }
    pthread_join(thread, NULL);
    trailing = seashell_audio_ring_take_trailing_drops(ring);
    result->concurrentPackets = reader.packets;
    result->concurrentDroppedFrames = reader.dropped + trailing;
    result->concurrentOrderKept = reader.ok && reader.next + trailing == job[2].stored + job[2].dropped &&
        reader.dropped + trailing == job[2].dropped && seashell_audio_ring_dropped_frames(ring) == job[2].dropped;
    seashell_audio_ring_destroy(ring);
    shape_free(&job[0].shape);
    shape_free(&reader.scratch);
    free(job);
    return result->orderKept && result->concurrentOrderKept && result->droppedFrames > 0;
}

typedef struct {
    int fd;
    uint8_t *bytes;
    size_t capacity;
    size_t length;
} pipe_reader;

static void *read_pipe(void *argument) {
    pipe_reader *reader = argument;
    while (reader->length < reader->capacity) {
        ssize_t count = read(reader->fd, reader->bytes + reader->length, reader->capacity - reader->length);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        reader->length += (size_t)count;
    }
    return NULL;
}

static int16_t pcm_value(uint64_t sample) { return (int16_t)(uint16_t)(sample * 7919 + 1); }

static void pcm_fill(int16_t *samples, size_t count, uint64_t first) {
    for (size_t index = 0; index < count; index++) samples[index] = pcm_value(first + index);
}

enum { CHUNK_QUEUED, CHUNK_REPLACED, CHUNK_SILENT };

typedef struct {
    seashell_pcm_pipe *pipe;
    size_t chunk;
    size_t chunks;
    uint8_t *kinds;
    int16_t *samples;
    uint64_t maxTicks;
    uint64_t replaced;
    dispatch_semaphore_t done;
} pipe_writer;

static void *write_chunks(void *argument) {
    pipe_writer *writer = argument;
    for (size_t index = 0; index < writer->chunks; index++) {
        uint64_t start = mach_absolute_time();
        if (index % 37 == 5) {
            seashell_pcm_pipe_append_zeros(writer->pipe, writer->chunk);
            writer->kinds[index] = CHUNK_SILENT;
        } else {
            pcm_fill(writer->samples, writer->chunk / 2, (uint64_t)index * writer->chunk / 2);
            size_t replaced = seashell_pcm_pipe_append(writer->pipe, writer->samples, writer->chunk);
            writer->replaced += replaced;
            writer->kinds[index] = replaced > 0 ? CHUNK_REPLACED : CHUNK_QUEUED;
        }
        seashell_pcm_pipe_flush(writer->pipe);
        uint64_t elapsed = mach_absolute_time() - start;
        if (elapsed > writer->maxTicks) writer->maxTicks = elapsed;
    }
    dispatch_semaphore_signal(writer->done);
    return NULL;
}

static bool chunk_matches(const uint8_t *bytes, size_t chunk, size_t index, bool silent) {
    const int16_t *samples = (const int16_t *)(bytes + index * chunk);
    for (size_t sample = 0; sample < chunk / 2; sample++) {
        int16_t expected = silent ? 0 : pcm_value((uint64_t)index * chunk / 2 + sample);
        if (samples[sample] != expected) return false;
    }
    return true;
}

/** Drains `pipe` into a reader thread and returns what came out. */
static bool drain_to_reader(seashell_pcm_pipe *pipe, int fds[2], pipe_reader *reader, size_t expected) {
    reader->fd = fds[0];
    reader->capacity = expected + 65536;
    reader->bytes = malloc(reader->capacity);
    reader->length = 0;
    if (reader->bytes == NULL) return false;
    pthread_t thread;
    if (pthread_create(&thread, NULL, read_pipe, reader) != 0) return false;
    int drained = seashell_pcm_pipe_drain(pipe, 10000);
    close(fds[1]);
    pthread_join(thread, NULL);
    close(fds[0]);
    return drained == 0;
}

bool seashell_pipe_check_run(size_t capacity, size_t chunk, seashell_pipe_check *result) {
    memset(result, 0, sizeof *result);
    signal(SIGPIPE, SIG_IGN);
    if (capacity == 0 || chunk == 0 || chunk % 2 != 0) return false;
    // 1. Nothing reads: twice what the pipe and the kernel together hold, with stretches of silence between.
    int fds[2];
    if (pipe(fds) != 0) return false;
    // On the heap, like the producer: a writer that never returns keeps using it.
    pipe_writer *heap = calloc(1, sizeof(pipe_writer));
    if (heap == NULL) return false;
    pipe_writer writer = { 0 };
    writer.pipe = seashell_pcm_pipe_create(fds[1], capacity);
    writer.chunk = chunk;
    writer.chunks = (capacity + 262144) / chunk * 2;
    writer.kinds = calloc(writer.chunks, 1);
    writer.samples = malloc(chunk);
    writer.done = dispatch_semaphore_create(0);
    if (writer.pipe == NULL || writer.kinds == NULL || writer.samples == NULL) return false;
    result->nonblocking = seashell_pcm_pipe_nonblocking(writer.pipe);
    pthread_t thread;
    *heap = writer;
    if (pthread_create(&thread, NULL, write_chunks, heap) != 0) return false;
    result->writerFinished = dispatch_semaphore_wait(heap->done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)10e9)) == 0;
    if (!result->writerFinished) return false;
    pthread_join(thread, NULL);
    writer = *heap;
    free(heap);
    result->bytes = (uint64_t)writer.chunks * chunk;
    result->replacedBytes = writer.replaced;
    result->maxAppendMicroseconds = ticks_to_microseconds(writer.maxTicks);
    // 2. The reader wakes: everything arrives, the replaced chunks as silence in their place.
    pipe_reader reader;
    bool drained = drain_to_reader(writer.pipe, fds, &reader, (size_t)result->bytes);
    result->lengthKept = drained && reader.length == result->bytes;
    result->orderKept = result->lengthKept;
    for (size_t index = 0; result->orderKept && index < writer.chunks; index++) {
        result->orderKept = chunk_matches(reader.bytes, chunk, index, writer.kinds[index] != CHUNK_QUEUED);
    }
    free(reader.bytes);
    seashell_pcm_pipe_destroy(writer.pipe);
    free(writer.kinds);

    // 3. Two marks and three stretches of silence in the queue: the third turns the audio before it to silence, in place.
    if (pipe(fds) != 0) return false;
    seashell_pcm_pipe *few = seashell_pcm_pipe_create_with_marks(fds[1], chunk * 8, 2);
    if (few == NULL) return false;
    const uint8_t plan[] = { CHUNK_QUEUED, CHUNK_SILENT, CHUNK_QUEUED, CHUNK_SILENT, CHUNK_QUEUED, CHUNK_SILENT, CHUNK_QUEUED };
    const size_t count = sizeof plan;
    for (size_t index = 0; index < count; index++) {
        if (plan[index] == CHUNK_SILENT) seashell_pcm_pipe_append_zeros(few, chunk);
        else {
            pcm_fill(writer.samples, chunk / 2, (uint64_t)index * chunk / 2);
            seashell_pcm_pipe_append(few, writer.samples, chunk);
        }
    }
    bool silencedOne = seashell_pcm_pipe_silenced(few) == chunk;
    drained = drain_to_reader(few, fds, &reader, count * chunk);
    result->marksExhaustedInPlace = drained && silencedOne && reader.length == count * chunk;
    for (size_t index = 0; result->marksExhaustedInPlace && index < count; index++) {
        // The audio before the third stretch (index 4) became silence; everything else is where it was.
        result->marksExhaustedInPlace = chunk_matches(reader.bytes, chunk, index, plan[index] == CHUNK_SILENT || index == 4);
    }
    free(reader.bytes);
    seashell_pcm_pipe_destroy(few);

    // 4. The reader is gone: the next write says so instead of killing the process with SIGPIPE.
    if (pipe(fds) != 0) return false;
    close(fds[0]);
    seashell_pcm_pipe *orphan = seashell_pcm_pipe_create(fds[1], chunk * 4);
    if (orphan == NULL) return false;
    seashell_pcm_pipe_append(orphan, writer.samples, chunk);
    result->readerGoneDetected = seashell_pcm_pipe_flush(orphan) == -1 && seashell_pcm_pipe_flush(orphan) == -1;
    seashell_pcm_pipe_destroy(orphan);
    close(fds[1]);
    free(writer.samples);
    return result->nonblocking && result->writerFinished && result->lengthKept && result->orderKept &&
        result->marksExhaustedInPlace && result->readerGoneDetected && result->replacedBytes > 0;
}
