#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import App from './app.tsx';
import { diarizeFile, type DiarizeFileOptions } from './diarize.ts';
import { transcribeFile } from './transcribe.ts';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`seashell - local speech to text

Usage:
  seashell                              Launch interactive live-mic mode
  seashell <file> ...                   Transcribe file(s) as plain text
  seashell --diarize [options] <file>   Emit speaker-attributed JSON

Diarization options:
  --channel-roles <roles>     Comma-separated roles in channel order
                              (for example: local,remote)
  --num-speakers <n>          Exact number of speakers
  --min-speakers <n>          Minimum number of speakers
  --max-speakers <n>          Maximum number of speakers
  --diarization-model <id>    Override the pyannote Hugging Face model
  --python <path>             Override the diarization Python executable

Supported formats: wav, mp3, ogg, flac (others converted locally)`);
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

function parsePositiveInteger(flag: string, raw: string | undefined): number {
  if (!raw) throw new Error(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseDiarizationArgs(rawArgs: string[]): {
  filePath: string;
  options: DiarizeFileOptions;
} {
  const options: DiarizeFileOptions = {};
  const files: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--diarize') continue;

    const nextValue = () => {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--channel-roles':
        options.channelRoles = nextValue().split(',').map((role) => role.trim());
        break;
      case '--num-speakers':
        options.numSpeakers = parsePositiveInteger(arg, nextValue());
        break;
      case '--min-speakers':
        options.minSpeakers = parsePositiveInteger(arg, nextValue());
        break;
      case '--max-speakers':
        options.maxSpeakers = parsePositiveInteger(arg, nextValue());
        break;
      case '--diarization-model':
        options.model = nextValue();
        break;
      case '--python':
        options.pythonPath = nextValue();
        break;
      default:
        if (arg?.startsWith('-')) throw new Error(`Unknown diarization option: ${arg}`);
        if (arg) files.push(arg);
    }
  }

  if (files.length !== 1) {
    throw new Error('Diarization requires exactly one audio file');
  }
  if (
    options.numSpeakers !== undefined &&
    (options.minSpeakers !== undefined || options.maxSpeakers !== undefined)
  ) {
    throw new Error('--num-speakers cannot be combined with speaker bounds');
  }
  if (
    options.minSpeakers !== undefined &&
    options.maxSpeakers !== undefined &&
    options.minSpeakers > options.maxSpeakers
  ) {
    throw new Error('--min-speakers cannot exceed --max-speakers');
  }

  return { filePath: files[0]!, options };
}

if (args.includes('--diarize')) {
  try {
    const { filePath, options } = parseDiarizationArgs(args);
    options.onDiarizationMessage = (message) => {
      process.stderr.write(message);
    };
    options.onWhisperProgress = (percentage) => {
      process.stderr.write(
        `\rTranscribing with whisper.cpp: ${percentage}%${percentage >= 100 ? '\n' : ''}`,
      );
    };
    const result = await diarizeFile(filePath, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (args.length > 0) {
  // File mode: transcribe file(s) and print to stdout
  for (const filePath of args) {
    const result = await transcribeFile(filePath);
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    process.stdout.write(result.text + '\n');
  }
} else {
  // Interactive mode
  process.stdout.write('\x1B[2J\x1B[0f');
  render(<App />);
}
