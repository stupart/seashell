import argparse
import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "diarize.py"
SPEC = importlib.util.spec_from_file_location("seashell_diarize_script", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def options(**overrides):
    values = {
        "num_speakers": None,
        "min_speakers": None,
        "max_speakers": None,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class SpeakerOptionTests(unittest.TestCase):
    def test_fixed_local_speaker_is_subtracted_from_total(self):
        self.assertEqual(
            MODULE.speaker_options(options(num_speakers=3), fixed_speakers=1),
            {"num_speakers": 2},
        )

    def test_bounds_are_adjusted_for_fixed_local_speaker(self):
        self.assertEqual(
            MODULE.speaker_options(
                options(min_speakers=1, max_speakers=4),
                fixed_speakers=1,
            ),
            {"max_speakers": 3},
        )

    def test_exact_count_must_leave_a_modelled_speaker(self):
        with self.assertRaisesRegex(ValueError, "model-processed channel"):
            MODULE.speaker_options(
                options(num_speakers=1),
                fixed_speakers=1,
            )


if __name__ == "__main__":
    unittest.main()
