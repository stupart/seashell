#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import App from './app.js';

// Clear the terminal
process.stdout.write('\x1B[2J\x1B[0f');

render(<App />);
