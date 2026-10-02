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


class _Available:
    def __init__(self, available):
        self._available = available

    def is_available(self):
        return self._available


def fake_torch(cuda=False, mps=False):
    torch = argparse.Namespace(cuda=_Available(cuda), backends=argparse.Namespace(mps=_Available(mps)))
    return torch


class DeviceTests(unittest.TestCase):
    def test_auto_prefers_cuda_then_the_apple_gpu_then_cpu(self):
        self.assertEqual(MODULE.resolve_device("auto", fake_torch(cuda=True, mps=True)), "cuda")
        self.assertEqual(MODULE.resolve_device("auto", fake_torch(mps=True)), "mps")
        self.assertEqual(MODULE.resolve_device("auto", fake_torch()), "cpu")
        self.assertEqual(MODULE.resolve_device("cpu", fake_torch(mps=True)), "cpu")

    def test_an_apple_gpu_failure_retries_on_cpu(self):
        attempts, moved = [], []

        def run():
            attempts.append(len(moved))
            if not moved:
                raise RuntimeError("unsupported MPS operation")
            return "turns"

        self.assertEqual(MODULE.run_with_cpu_fallback("mps", run, lambda: moved.append(True)), ("cpu", "turns"))
        self.assertEqual(attempts, [0, 1])

    def test_other_device_failures_are_not_hidden(self):
        def run():
            raise RuntimeError("out of memory")

        with self.assertRaises(RuntimeError):
            MODULE.run_with_cpu_fallback("cpu", run, lambda: None)


if __name__ == "__main__":
    unittest.main()
