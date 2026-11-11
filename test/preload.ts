import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Status checks copy permission-bearing helpers into the runtime folder. Pointed at the
// real one, a test run replaces the installed microphone helper and macOS drops its
// permission, so the next call records only the other side.
process.env.SEASHELL_RUNTIME_DIR ||= mkdtempSync(join(tmpdir(), 'seashell-test-runtime-'));

// Automation approvals are signed with a key from the login Keychain. Tests use a key file beside their own settings.
process.env.SEASHELL_APPROVAL_KEYCHAIN = 'off';

// Naming, forgetting and private meetings change the voice library. Tests get their own, never the one in Application Support.
process.env.SEASHELL_VOICES_DIR ||= mkdtempSync(join(tmpdir(), 'seashell-test-voices-'));

// Vocabulary and briefs sit beside the real library by default. A test that names no library
// must never read the owner's words or write a brief there.
const scratch = mkdtempSync(join(tmpdir(), 'seashell-test-files-'));
process.env.SEASHELL_VOCABULARY_FILE ||= join(scratch, 'Vocabulary.txt');
process.env.SEASHELL_BRIEFS_DIR ||= join(scratch, 'Briefs');

// `seashell note` leaves its notes beside the recorder's command file, and every watch poll
// reads and deletes them. A test's watch must never take a note typed during a real call.
process.env.SEASHELL_MEETING_COMMAND_PATH ||= join(scratch, 'meeting-command.json');
