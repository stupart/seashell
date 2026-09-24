import importlib.util
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

SPEC = importlib.util.spec_from_file_location('diarization_gym', Path(__file__).parents[1] / 'scripts/gym-diarization.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReferenceTests(unittest.TestCase):
    def test_clips_shifts_and_retains_overlapping_speakers(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'reference.zip'
            with ZipFile(archive, 'w') as source:
                source.writestr('segments/ES2002a.A.segments.xml', '<root><segment transcriber_start="179" transcriber_end="182"/><segment transcriber_start="359" transcriber_end="365"/></root>')
                source.writestr('segments/ES2002a.B.segments.xml', '<root><segment transcriber_start="181" transcriber_end="183"/></root>')
                source.writestr('segments/ES2002a.C.segments.xml', '<root><segment transcriber_start="1" transcriber_end="5"/></root>')
                source.writestr('segments/ES2002a.D.segments.xml', '<root/>')
            self.assertEqual(MODULE.reference_turns(archive), [
                {'start': 0, 'end': 2, 'speaker': 'A'},
                {'start': 1, 'end': 3, 'speaker': 'B'},
                {'start': 179, 'end': 180, 'speaker': 'A'},
            ])

    def test_scorer_is_label_invariant_and_penalizes_merged_speakers(self):
        try:
            import pyannote.metrics
        except ImportError:
            self.skipTest('Optional real scoring dependency; run with diarization Python')
        reference = {'duration': 20, 'turns': [
            {'start': 0, 'end': 10, 'speaker': 'A'},
            {'start': 10, 'end': 20, 'speaker': 'B'},
        ]}
        perfect = {'turns': [dict(t, speaker=f"cluster-{t['speaker']}") for t in reference['turns']]}
        merged = {'turns': [{'start': 0, 'end': 20, 'speaker': 'one'}]}
        self.assertAlmostEqual(MODULE.score(reference, perfect)['scores']['strict']['diarization error rate'], 0)
        self.assertAlmostEqual(MODULE.score(reference, merged)['scores']['strict']['diarization error rate'], .5)


if __name__ == '__main__':
    unittest.main()
