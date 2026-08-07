#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import App from './app.tsx';
import { CLI_HELP, parseCliArgs } from './cli-args.ts';
import { executeCliCommand } from './cli-runtime.ts';

try {
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    process.stdout.write(CLI_HELP);
  } else if (command.kind === 'tui') {
    process.stdout.write('\x1B[2J\x1B[0f');
    render(<App libraryDir={command.libraryDir} />);
  } else {
    process.exitCode = await executeCliCommand(command);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
