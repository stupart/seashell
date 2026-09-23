#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import App from './app.tsx';
import AIProviderPicker from './AISettings.tsx';
import { loadConfig, updateMeetingConfig } from './config.ts';
import { CLI_HELP, parseCliArgs } from './cli-args.ts';
import { executeCliCommand } from './cli-runtime.ts';

try {
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    process.stdout.write(CLI_HELP);
  } else if (command.kind === 'ai-setup') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run seashell ai setup in a terminal, or use seashell meeting setup --backend <backend> --model <model>.');
    let saved: string | undefined;
    const ui = render(<AIProviderPicker current={loadConfig().meeting}
      onClose={() => ui.unmount()}
      onSave={(patch) => {
        updateMeetingConfig(patch);
        saved = `Meeting AI roles saved · ${patch.mode === 'hybrid' ? 'Live analysis + final notes' : patch.mode === 'streaming' ? 'Live analysis only' : 'Final notes only'}`;
        ui.unmount();
      }} />);
    await ui.waitUntilExit();
    if (saved) process.stdout.write(saved + '\n');
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
