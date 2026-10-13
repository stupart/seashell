# Third-party notices

## OpenWhispr macOS audio tap

`native/macos-system-audio.swift` is adapted from OpenWhispr's
`resources/macos-audio-tap.swift`.

Copyright (c) 2024 OpenWhispr Team

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Meeting Transcriber microphone-process detection

`native/macos-meeting-signals.swift` and `src/meeting-automation.ts` adapt the
Core Audio process-object discovery and confirmation/grace/cooldown patterns
from `pasrom/meeting-transcriber`.

Copyright (c) 2025 pasrom

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## FluidAudio (native speaker separation)

`native/bin/seashell-speakers` is built from `native/speakers/` and links
[FluidAudio](https://github.com/FluidInference/FluidAudio) 0.17.7, which is
licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0). FluidAudio's own third-party
notices, including fastcluster (BSD-2-Clause) and VBx (Apache-2.0) used by its
clustering, ship in its source tree under `ThirdPartyLicenses/`. Sea Shell
builds it without its default `NemoTextProcessing` trait, so that binary is not
included.

## Speaker diarization models

`seashell setup --speakers` downloads FluidInference's Core ML conversion of
[pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
from https://huggingface.co/FluidInference/speaker-diarization-coreml. The
Community-1 artifacts are distributed under CC-BY-4.0; see that repository's
NOTICE.md for attribution and scope. Sea Shell does not redistribute them.
