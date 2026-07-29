# Sea Shell

Local speech-to-text that runs entirely on your Mac. Core transcription needs
no cloud account or API key. Optional speaker diarization needs a one-time
Hugging Face token to download its gated model; inference stays local.

Uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with Metal GPU acceleration for fast transcription.

![Sea Shell — the live transcription TUI: it keeps listening for your next words while whisper is still transcribing the last ones, so nothing gets dropped.](docs/seashell.png)

## Features

- **Always listening** - Auto-detects when you start/stop speaking
- **Never misses speech** - Concurrent architecture transcribes while still listening
- **Transcribe audio files** - Drag-and-drop a file onto the window, press `F` for a file picker, or run `seashell file.mp3` — wav, mp3, ogg, flac and more (auto-converted)
- **Speaker diarization** - Opt-in local pyannote speaker attribution with structured JSON
- **Stereo channel roles** - Preserve mic/system separation as local/remote before speaker clustering
- **30-second chunking** - Long recordings are automatically split for faster transcription
- **Pause/resume** - Space to pause, transcribes captured audio before pausing
- **Copy to clipboard** - Press C to copy transcript
- **GPU accelerated** - Uses Apple Metal for fast inference

## Requirements

- macOS (Apple Silicon recommended)
- [Bun](https://bun.sh) - JavaScript runtime
- sox - Audio recording (`brew install sox`)
- cmake - For building whisper.cpp (`brew install cmake`)
- git - For cloning whisper.cpp

Speaker diarization is optional and additionally needs Python 3.10+ (3.12
recommended) and FFmpeg. Its PyTorch dependencies are intentionally not part of
the base installer.

## Installation

```bash
# Clone the repo
git clone https://github.com/stupart/seashell.git
cd seashell

# Run the installer
chmod +x install.sh
./install.sh
```

The installer will:
1. Build whisper.cpp with Metal support
2. Download the Whisper large-v3-turbo model (547MB)
3. Download the Silero VAD model
4. Install dependencies
5. Create global `seashell` command

## Usage

```bash
seashell
```

### Controls

| Key | Action |
|-----|--------|
| `Space` | Pause/Resume |
| `F` | Transcribe an audio file (opens a file picker) |
| `C` | Copy transcript to clipboard |
| `Delete` | Clear transcript |
| `Q` or `Esc` | Quit |

### Transcribe a file

Got an existing recording? seashell transcribes files too — no mic required:

```bash
seashell interview.m4a              # prints the transcript to stdout
seashell voicmemo.mp3 meeting.wav   # transcribe several, in order
```

Supported out of the box: wav, mp3, ogg, flac — anything else is auto-converted via `afconvert` first. Because it writes to stdout, it pipes: `seashell talk.mp3 > talk.txt`.

Or do it live from inside the TUI: **drag an audio file from Finder onto the window** (its path pastes in and transcribes), or press **`F`** for a native file picker. The mic pauses while the file transcribes, shows progress, and resumes listening when it's done.

### Speaker diarization

Sea Shell uses the current fully local
[`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1)
pipeline. It improves on the now-legacy 3.1 pipeline and exposes exclusive
speaker turns designed for speech-to-text alignment.

One-time setup:

```bash
brew install python@3.12 ffmpeg
python3.12 -m venv .venv-diarization
source .venv-diarization/bin/activate
python -m pip install -r scripts/requirements-diarization.txt
```

Then:

1. Sign in to Hugging Face and accept the
   [Community-1 model conditions](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Create a read token at
   [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
3. Export it for the first download:

```bash
export HF_TOKEN=hf_your_read_token
seashell --diarize meeting.m4a > meeting.json
```

The first run downloads the model into the Hugging Face cache. Later runs use
the local copy; `HF_HUB_OFFLINE=1` can enforce cached-only operation.
`PYANNOTE_METRICS_ENABLED=0` disables pyannote's anonymous telemetry.
Whisper uses Metal on supported Macs; pyannote defaults to CPU there. An
experimental MPS run can be requested with
`SEASHELL_DIARIZATION_DEVICE=mps`, but it is not pyannote's documented default.

If you specifically need the legacy `speaker-diarization-3.1` checkpoint, use a
separate Python 3.11 environment with `pyannote.audio==3.4.0`, accept both the
[`segmentation-3.0`](https://huggingface.co/pyannote/segmentation-3.0) and
[`speaker-diarization-3.1`](https://huggingface.co/pyannote/speaker-diarization-3.1)
conditions, and select it explicitly:

```bash
python3.11 -m venv .venv-pyannote31
.venv-pyannote31/bin/python -m pip install "pyannote.audio==3.4.0" soundfile
seashell --diarize \
  --python .venv-pyannote31/bin/python \
  --diarization-model pyannote/speaker-diarization-3.1 \
  meeting.wav
```

Speaker IDs are recording-local clusters, not identities that remain stable
across files. If the count is known, pass `--num-speakers 3`; bounds are also
available through `--min-speakers` and `--max-speakers`. Counts describe the
whole recording: with `--channel-roles local,remote`, the fixed local identity
is subtracted before constraining the remote clustering pass.

The JSON schema uses seconds:

```json
{
  "transcript": [
    {
      "start": 0.42,
      "end": 2.18,
      "speaker": "SPEAKER_00",
      "text": "Let's ship it."
    }
  ],
  "speakers": [
    { "id": "SPEAKER_00", "label": "SPEAKER_00" }
  ]
}
```

`summary`, `decisions`, and `action_items` are optional fields reserved for a
later enrichment pass. No LLM provider is built in.

### Two-channel mic + system audio

The current live TUI deliberately remains a low-latency mono listener. The
diarization file path does accept stereo audio and can treat explicit channel
identity as stronger evidence than voice clustering:

```bash
seashell --diarize \
  --channel-roles local,remote \
  meeting-stereo.wav > meeting.json
```

With that mapping, the left/first channel is transcribed separately and fixed
to `LOCAL`. The right/second channel is transcribed separately, then pyannote
splits remote participants into `REMOTE_00`, `REMOTE_01`, and so on. Because
aggregate-device channel order varies, Sea Shell never guesses this mapping.
Check it with `soxi -c meeting-stereo.wav` and listen to each channel before
assigning roles.

One pragmatic macOS routing setup:

1. Install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole).
2. In Audio MIDI Setup, create a Multi-Output Device containing your headphones
   and BlackHole; use it as macOS output so meeting audio reaches both.
3. Create a separate Aggregate Device containing the physical microphone and
   BlackHole. Use the same sample rate for both and enable drift correction on
   every non-clock device, following
   [Apple's aggregate-device guide](https://support.apple.com/en-au/HT202000).
4. Keep Google Meet's microphone set to the physical mic, not the aggregate, to
   avoid feeding remote audio back into the call. Headphones also reduce bleed.
5. Record/remix the actual aggregate channel numbers into two channels. For
   example, if mic is input 1 and BlackHole is inputs 2–3:

```bash
sox -t coreaudio "Seashell Capture" \
  -r 16000 -b 16 meeting-stereo.wav remix 1 2,3
```

Substitute the device name and input indices shown in Audio MIDI Setup. This
external recording step is necessary today because the live TUI forces mono.

## How It Works

1. **sox** listens for voice activity (1.5% threshold)
2. When speech is detected, recording begins
3. After 2 seconds of silence (or 30 seconds max), recording stops
4. **whisper.cpp** transcribes the audio using GPU
5. A new listener starts immediately (concurrent with transcription)
6. Transcribed text appears in the terminal

The opt-in diarization path is separate:

1. Normalize the source to 16 kHz WAV without discarding channels
2. Run whisper.cpp with DTW timing (and without its timeline-compacting VAD)
3. Run local pyannote diarization (or split known channels first)
4. Assign each word by its DTW anchor (or greatest-overlap fallback)
5. Merge adjacent same-speaker text and emit structured JSON

For future Meet name attribution, `SpeakerLabeler` accepts timestamped
screenshots and an attendee list; the included stub preserves current IDs. A
separate provider-neutral `TranscriptEnricher` interface can add summaries,
decisions, and action items without coupling Sea Shell to an LLM vendor.

## Models

- **Whisper large-v3-turbo-q5_0** - Main transcription model (547MB, quantized)
- **Silero VAD v6.2.0** - Voice activity detection

## License

MIT

The optional Community-1 model weights are downloaded separately under
[CC BY 4.0](https://huggingface.co/pyannote/speaker-diarization-community-1);
they are not bundled with Sea Shell.

---

Sea Shell is the local-first STT engine behind [conch](https://github.com/stupart/conch), a hands-free voice loop for Claude Code.

A small open experiment from [Blueprint Studio](https://blueprintstudio.ai) — we build AI products that feel good to use.
