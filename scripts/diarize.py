#!/usr/bin/env python3
"""Run local pyannote speaker diarization and emit machine-readable JSON.

Stdout is reserved for JSON so the TypeScript wrapper can parse it. Progress
and actionable setup errors are written to stderr.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import re
import sys
from contextlib import redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "pyannote/speaker-diarization-community-1"
LEGACY_MODEL = "pyannote/speaker-diarization-3.1"


@dataclass(frozen=True)
class Turn:
    start: float
    end: float
    speaker: str
    role: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run local pyannote speaker diarization and print JSON."
    )
    parser.add_argument("audio", type=Path, help="WAV file to diarize")
    parser.add_argument(
        "--model",
        default=os.environ.get("SEASHELL_DIARIZATION_MODEL", DEFAULT_MODEL),
        help=(
            "Hugging Face model ID "
            f"(default: {DEFAULT_MODEL}; legacy: {LEGACY_MODEL})"
        ),
    )
    parser.add_argument(
        "--channel-roles",
        help=(
            "Comma-separated channel roles in file order, e.g. local,remote. "
            "Each channel is diarized independently before timestamps are merged."
        ),
    )
    parser.add_argument("--num-speakers", type=int)
    parser.add_argument("--min-speakers", type=int)
    parser.add_argument("--max-speakers", type=int)
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "cuda", "mps"),
        default=os.environ.get("SEASHELL_DIARIZATION_DEVICE", "auto"),
        help="Torch device (auto uses CUDA when available, otherwise CPU)",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not args.audio.is_file():
        raise ValueError(f"Audio file not found: {args.audio}")
    if args.num_speakers is not None and (
        args.min_speakers is not None or args.max_speakers is not None
    ):
        raise ValueError(
            "--num-speakers cannot be combined with --min-speakers/--max-speakers"
        )
    for name in ("num_speakers", "min_speakers", "max_speakers"):
        value = getattr(args, name)
        if value is not None and value < 1:
            raise ValueError(f"--{name.replace('_', '-')} must be at least 1")
    if (
        args.min_speakers is not None
        and args.max_speakers is not None
        and args.min_speakers > args.max_speakers
    ):
        raise ValueError("--min-speakers cannot exceed --max-speakers")


def load_dependencies() -> tuple[Any, Any, Any]:
    try:
        import soundfile
        import torch
        from pyannote.audio import Pipeline
    except ImportError as error:
        raise RuntimeError(
            "Diarization dependencies are missing. Activate .venv-diarization "
            "and run: python -m pip install -r scripts/requirements-diarization.txt"
        ) from error
    return torch, soundfile, Pipeline


def resolve_device(requested: str, torch: Any) -> str:
    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")
    if requested == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS was requested but is not available")
    return requested


def load_pipeline(Pipeline: Any, model: str, token: str | None) -> Any:
    parameters = inspect.signature(Pipeline.from_pretrained).parameters
    kwargs: dict[str, Any] = {}
    if token:
        # pyannote.audio 4 uses `token`; the requested legacy 3.1 API used
        # `use_auth_token`. Supporting both keeps the model override useful.
        if "token" in parameters:
            kwargs["token"] = token
        else:
            kwargs["use_auth_token"] = token
    pipeline = Pipeline.from_pretrained(model, **kwargs)
    if pipeline is None:
        raise RuntimeError(
            f"Could not load {model}. Set HF_TOKEN and accept its Hugging Face "
            "user conditions before the first download."
        )
    return pipeline


def speaker_options(
    args: argparse.Namespace, fixed_speakers: int = 0
) -> dict[str, int]:
    options: dict[str, int] = {}
    for name in ("num_speakers", "min_speakers", "max_speakers"):
        value = getattr(args, name)
        if value is not None:
            adjusted = value - fixed_speakers
            if name == "min_speakers" and adjusted < 1:
                continue
            if adjusted < 1:
                raise ValueError(
                    f"--{name.replace('_', '-')} must leave at least one "
                    "speaker for the model-processed channel"
                )
            options[name] = adjusted
    return options


def annotation_from_output(output: Any) -> Any:
    # Community-1's exclusive output avoids overlapping ASR assignments. Fall
    # back through the current regular output and legacy 3.1 Annotation result.
    annotation = getattr(output, "exclusive_speaker_diarization", None)
    if annotation is None:
        annotation = getattr(output, "speaker_diarization", None)
    if annotation is None:
        annotation = output
    if not hasattr(annotation, "itertracks"):
        raise RuntimeError("pyannote returned an unsupported diarization result")
    return annotation


def safe_prefix(role: str) -> str:
    prefix = re.sub(r"[^A-Za-z0-9]+", "_", role).strip("_").upper()
    return prefix or "CHANNEL"


def collect_turns(
    annotation: Any,
    role: str | None,
    identities: dict[tuple[str, str], str],
    role_counts: dict[str, int],
) -> tuple[list[Turn], dict[str, str]]:
    turns: list[Turn] = []
    speakers: dict[str, str] = {}
    normalized_role = role.strip().lower() if role else None

    for segment, _, raw_speaker in annotation.itertracks(yield_label=True):
        raw_id = str(raw_speaker)
        if normalized_role == "local":
            speaker_id = "LOCAL"
            label = "local"
        elif normalized_role:
            identity_key = (normalized_role, raw_id)
            speaker_id = identities.get(identity_key, "")
            if not speaker_id:
                ordinal = role_counts.get(normalized_role, 0)
                role_counts[normalized_role] = ordinal + 1
                speaker_id = f"{safe_prefix(normalized_role)}_{ordinal:02d}"
                identities[identity_key] = speaker_id
            ordinal = int(speaker_id.rsplit("_", 1)[-1]) + 1
            label = f"{normalized_role} {ordinal}"
        else:
            speaker_id = raw_id
            label = raw_id

        start = max(0.0, float(segment.start))
        end = max(start, float(segment.end))
        turns.append(
            Turn(
                start=round(start, 3),
                end=round(end, 3),
                speaker=speaker_id,
                role=normalized_role,
            )
        )
        speakers[speaker_id] = label

    return turns, speakers


def coalesce_turns(turns: list[Turn]) -> list[Turn]:
    ordered = sorted(turns, key=lambda turn: (turn.start, turn.end, turn.speaker))
    merged: list[Turn] = []
    for turn in ordered:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous.speaker == turn.speaker
            and previous.role == turn.role
            and turn.start <= previous.end + 0.05
        ):
            merged[-1] = Turn(
                start=previous.start,
                end=max(previous.end, turn.end),
                speaker=previous.speaker,
                role=previous.role,
            )
        else:
            merged.append(turn)
    return merged


def run(args: argparse.Namespace) -> dict[str, Any]:
    validate_args(args)
    torch, soundfile, Pipeline = load_dependencies()

    samples, sample_rate = soundfile.read(
        args.audio, dtype="float32", always_2d=True
    )
    # Transpose as a strided view instead of duplicating long meeting audio.
    waveform = torch.from_numpy(samples).transpose(0, 1)
    channel_count = int(waveform.shape[0])

    roles = None
    if args.channel_roles:
        roles = [role.strip().lower() for role in args.channel_roles.split(",")]
        if any(not role for role in roles):
            raise ValueError("--channel-roles cannot contain an empty role")
        if len(set(roles)) != len(roles):
            raise ValueError("--channel-roles must be unique")
        role_prefixes = [safe_prefix(role) for role in roles]
        if len(set(role_prefixes)) != len(role_prefixes):
            raise ValueError(
                "--channel-roles normalize to colliding speaker ID prefixes"
            )
        if len(roles) != channel_count:
            raise ValueError(
                f"--channel-roles listed {len(roles)} roles, but the WAV has "
                f"{channel_count} channels"
            )

    modelled_channels = sum(role != "local" for role in roles) if roles else 1
    has_speaker_constraint = any(
        getattr(args, name) is not None
        for name in ("num_speakers", "min_speakers", "max_speakers")
    )
    if modelled_channels > 1 and has_speaker_constraint:
        raise ValueError(
            "Speaker-count options are ambiguous with multiple model-processed "
            "channels; provide one remote channel or omit the constraint"
        )

    fixed_speakers = 1 if roles and "local" in roles else 0
    options = speaker_options(args, fixed_speakers)

    print(f"Loading {args.model}...", file=sys.stderr)
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    pipeline = load_pipeline(Pipeline, args.model, token)
    device = resolve_device(args.device, torch)
    pipeline.to(torch.device(device))
    print("Diarizing audio...", file=sys.stderr)

    all_turns: list[Turn] = []
    all_speakers: dict[str, str] = {}
    identities: dict[tuple[str, str], str] = {}
    role_counts: dict[str, int] = {}

    if roles:
        # Explicit channel identity is a stronger prior than voice clustering.
        # Diarize each channel separately so pyannote never downmixes away that
        # near-perfect local-vs-remote signal.
        for index, role in enumerate(roles):
            if role == "local":
                all_speakers["LOCAL"] = "local"
                continue
            channel_options = dict(options)
            output = pipeline(
                {
                    "waveform": waveform[index : index + 1],
                    "sample_rate": sample_rate,
                },
                **channel_options,
            )
            turns, speakers = collect_turns(
                annotation_from_output(output),
                role,
                identities,
                role_counts,
            )
            all_turns.extend(turns)
            all_speakers.update(speakers)
    else:
        # Match pyannote's file behavior explicitly: multi-channel files are
        # averaged unless channel roles were supplied.
        mono = waveform.mean(dim=0, keepdim=True)
        output = pipeline(
            {"waveform": mono, "sample_rate": sample_rate},
            **options,
        )
        all_turns, all_speakers = collect_turns(
            annotation_from_output(output),
            None,
            identities,
            role_counts,
        )

    turns = coalesce_turns(all_turns)
    return {
        "model": args.model,
        "device": device,
        "channels": channel_count,
        "turns": [
            {
                "start": turn.start,
                "end": turn.end,
                "speaker": turn.speaker,
                **({"role": turn.role} if turn.role else {}),
            }
            for turn in turns
        ],
        "speakers": [
            {"id": speaker_id, "label": label}
            for speaker_id, label in sorted(all_speakers.items())
        ],
    }


def main() -> int:
    args = parse_args()
    try:
        # Some ML dependencies print status messages directly. Keep the
        # subprocess contract strict: only the final JSON is allowed on stdout.
        with redirect_stdout(sys.stderr):
            result = run(args)
    except Exception as error:  # Keep stdout parseable and present concise setup help.
        print(f"Diarization failed: {error}", file=sys.stderr)
        message = str(error).lower()
        if (
            "huggingface" in message
            or "hugging face" in message
            or "gated" in message
        ):
            print(
                "Check HF_TOKEN and accept the model's Hugging Face user conditions.",
                file=sys.stderr,
            )
        return 1

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
