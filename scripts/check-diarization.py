#!/usr/bin/env python3
"""Verify real dependencies and model loading, without opening a microphone."""
import argparse
import json
import os
import sys
from contextlib import redirect_stdout

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--download', action='store_true')
args = parser.parse_args()
os.environ.setdefault('PYANNOTE_METRICS_ENABLED', '0')
if not args.download:
    os.environ['HF_HUB_OFFLINE'] = '1'

result = {'ready': False, 'stage': 'dependencies', 'detail': 'Speaker dependencies could not load. Run seashell setup --speakers; for a custom Python, install scripts/requirements-diarization.txt into that environment.'}
try:
    with redirect_stdout(sys.stderr):
        from diarize import load_dependencies, load_pipeline
        _, _, Pipeline = load_dependencies()
        result.update(stage='model', detail='The speaker model could not load. Accept its access conditions and sign in to Hugging Face, then retry. Check your connection or cached model when offline.')
        load_pipeline(Pipeline, args.model, os.environ.get('HF_TOKEN') or os.environ.get('HUGGINGFACE_TOKEN'))
        result.update(ready=True, stage='ready', detail='Speaker identification is ready. The model loaded successfully; subsequent runs use the local cache.')
except Exception as error:
    # Do not echo authenticated URLs or credentials from third-party exceptions.
    result['errorType'] = type(error).__name__
json.dump(result, sys.stdout)
sys.stdout.write('\n')
