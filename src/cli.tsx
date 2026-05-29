#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import App from './app.tsx';
import { transcribeFile } from './transcribe.ts';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`seashell - speech to text

Usage:
  seashell              Launch interactive mode (live mic transcription)
  seashell <file> ...   Transcribe audio file(s) to stdout

Supported formats: wav, mp3, ogg, flac (others converted via afconvert)`);
  process.exit(0);
}

if (args.length > 0) {
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
