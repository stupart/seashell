import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Status checks copy permission-bearing helpers into the runtime folder. Pointed at the
// real one, a test run replaces the installed microphone helper and macOS drops its
// permission, so the next call records only the other side.
process.env.SEASHELL_RUNTIME_DIR ||= mkdtempSync(join(tmpdir(), 'seashell-test-runtime-'));

// Automation approvals are signed with a key from the login Keychain. Tests use a key file beside their own settings.
process.env.SEASHELL_APPROVAL_KEYCHAIN = 'off';
