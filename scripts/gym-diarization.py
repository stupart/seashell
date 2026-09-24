#!/usr/bin/env python3
"""Reproducible public-video speaker smoke test; no microphone or private library."""
import argparse
import hashlib
import json
import os
import resource
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
START, DURATION = 180, 180
SOURCES = [
    ('ES2002a.Corner.avi', 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/video/ES2002a.Corner.avi', '40fdbfda266ca2ecdc56c214738234aa1ec1e21dbbf4d5a1fdd53f974cc2e730'),
    ('ES2002a.Mix-Headset.wav', 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav', '9c76866990fcc8b84006dc32d273ad99df439090b748ebe72103bb78c3216ee7'),
    ('ami_public_manual_1.6.2.zip', 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip', 'b56e5babb2496b8795deeeda7e71178d7fbc9963f94276cf2a3f4b56ebbc9f9d'),
]


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def reference_turns(archive, start=START, duration=DURATION):
    turns = []
    with ZipFile(archive) as source:
        for speaker in 'ABCD':
            # Read only named XML members; never extract untrusted archive paths.
            tree = ET.fromstring(source.read(f'segments/ES2002a.{speaker}.segments.xml'))
            for segment in tree:
                if 'transcriber_start' not in segment.attrib:
                    continue
                a = max(start, float(segment.attrib['transcriber_start']))
                b = min(start + duration, float(segment.attrib['transcriber_end']))
                if b > a:
                    turns.append({'start': round(a - start, 3), 'end': round(b - start, 3), 'speaker': speaker})
    return sorted(turns, key=lambda turn: (turn['start'], turn['end'], turn['speaker']))


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, url, checksum in SOURCES:
        target = directory / name
        if not target.exists():
            print(f'Downloading public AMI fixture: {name}', file=sys.stderr)
            temporary = target.with_suffix(target.suffix + '.part')
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            temporary.replace(target)
        with target.open('rb') as fixture:
            actual_checksum = hashlib.file_digest(fixture, 'sha256').hexdigest()
        if actual_checksum != checksum:
            raise ValueError(f'Fixture checksum differs: {target}. Remove it and retry; do not score changed sources.')
    video = directory / 'ami-es2002a-180-360.mov'
    audio = directory / 'ami-es2002a-180-360.wav'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', str(START), '-i', str(directory / SOURCES[0][0]),
        '-ss', str(START), '-i', str(directory / SOURCES[1][0]), '-t', str(DURATION),
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast',
        '-c:a', 'pcm_s16le', str(video)], check=True)
    # Score the same audio that Seashell will extract from the video container.
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(video),
        '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(audio)], check=True)
    reference = {'duration': DURATION, 'offset': START, 'turns': reference_turns(directory / SOURCES[2][0]),
        'method': 'AMI manual utterance segments, clipped and shifted to excerpt time; includes within-utterance pauses.',
        'attribution': 'AMI Meeting Corpus, ES2002a; AMI Consortium; CC BY 4.0. https://groups.inf.ed.ac.uk/ami/download/',
        'limitations': 'Integration smoke test, not a held-out benchmark. AMI was used to develop diarization models. Headset mix is easier than laptop audio. No visual speaker identity is inferred; video/audio lip synchronization has not been independently validated.',
        'sources': [{'file': name, 'url': url, 'sha256': digest} for name, url, digest in SOURCES]}
    write_json(directory / 'reference.json', reference)
    return video, audio, reference


def score(reference, prediction):
    from pyannote.core import Annotation, Segment, Timeline
    from pyannote.metrics.diarization import DiarizationErrorRate

    def annotation(turns):
        result = Annotation()
        for i, turn in enumerate(turns):
            if turn['end'] > turn['start']:
                result[Segment(turn['start'], turn['end']), i] = turn['speaker']
        return result

    ref, hyp = annotation(reference['turns']), annotation(prediction['turns'])
    uem = Timeline([Segment(0, reference['duration'])])
    scores = {}
    for label, collar, skip_overlap in [('forgiving', .25, True), ('strict', 0, False)]:
        metric = DiarizationErrorRate(collar=collar, skip_overlap=skip_overlap)
        scores[label] = metric(ref, hyp, uem=uem, detailed=True)
    return {'referenceSpeakers': len(ref.labels()), 'predictedSpeakers': len(hyp.labels()),
        'mapping': DiarizationErrorRate().optimal_mapping(ref, hyp, uem=uem), 'scores': scores,
        'note': 'Lower DER is better; label mapping is permutation invariant. Strict includes overlap, which the production exclusive output cannot represent. No quality pass threshold is claimed from one clip.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--run', action='store_true', help='Run the real model and Seashell video ingestion after preparing the fixture')
    parser.add_argument('--num-speakers', type=int, help='Optional known count; omit for the primary blind-count run')
    args = parser.parse_args()
    directory = args.cache_dir.resolve()
    video, audio, reference = prepare(directory)
    report = {'status': 'prepared', 'video': str(video), 'referenceSpeakers': len({t['speaker'] for t in reference['turns']}),
        'qualityMeasured': False, 'limitations': reference['limitations']}
    report_path = directory / ('result-known-count.json' if args.num_speakers else 'result-auto-count.json')
    write_json(report_path, report)
    if args.run:
        started = time.monotonic()
        env = {**os.environ, 'PYANNOTE_METRICS_ENABLED': '0', 'SEASHELL_DIARIZATION_PYTHON': sys.executable,
            'SEASHELL_CONFIG': str(directory / 'isolated-config.json'), 'SEASHELL_LIBRARY_DIR': str(directory / 'isolated-library')}
        count = ['--num-speakers', str(args.num_speakers)] if args.num_speakers else []
        run_name = 'known' if args.num_speakers else 'auto'
        try:
            with (directory / f'{run_name}-model.log').open('w') as log:
                raw = subprocess.run([sys.executable, str(ROOT / 'scripts/diarize.py'), str(audio), *count],
                    env=env, stdout=subprocess.PIPE, stderr=log, text=True, timeout=1800, check=True)
            prediction = json.loads(raw.stdout)
            write_json(directory / f'{run_name}-turns.json', prediction)
            report.update(qualityMeasured=True, modelSeconds=round(time.monotonic() - started, 2), metrics=score(reference, prediction))
            # Exercise the actual CLI, media preparation, ASR, and speaker merge separately.
            with (directory / f'{run_name}-transcribe.log').open('w') as log:
                result = subprocess.run(['bun', str(ROOT / 'src/cli.tsx'), 'transcribe', str(video), '--speakers',
                    '--format', 'json', '--no-save', *count], cwd=ROOT, env=env,
                    stdout=subprocess.PIPE, stderr=log, text=True, timeout=1800, check=True)
            transcript = json.loads(result.stdout)
            write_json(directory / f'{run_name}-transcript.json', transcript)
            segments = transcript.get('transcript', [])
            if not segments or not any(segment.get('text', '').strip() for segment in segments):
                raise ValueError('The video pipeline returned no speech')
            report.update(status='completed', transcriptSegments=len(segments),
                unknownSegments=sum(segment.get('speaker') in (None, 'UNKNOWN') for segment in segments))
        except Exception as error:
            report.update(status='failed', error=str(error), nextStep='Inspect the run logs. For model access or missing dependencies, run seashell setup --speakers.')
        finally:
            report['totalSeconds'] = round(time.monotonic() - started, 2)
            report['peakChildRssBytes'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)
            report['memoryMeasurement'] = 'Maximum RSS of completed child processes (includes fixture preparation); not aggregate RAM or a leak/soak measurement.'
            write_json(report_path, report)
    print(json.dumps(report, indent=2))
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main())
