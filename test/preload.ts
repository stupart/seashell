import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Status checks copy permission-bearing helpers into the runtime folder. Pointed at the
// real one, a test run replaces the installed microphone helper and macOS drops its
// permission, so the next call records only the other side.
process.env.SEASHELL_RUNTIME_DIR ||= mkdtempSync(join(tmpdir(), 'seashell-test-runtime-'));

// Vocabulary and briefs sit beside the real library by default. A test that names no library
// must never read the owner's words or write a brief there.
const scratch = mkdtempSync(join(tmpdir(), 'seashell-test-files-'));
process.env.SEASHELL_VOCABULARY_FILE ||= join(scratch, 'Vocabulary.txt');
process.env.SEASHELL_BRIEFS_DIR ||= join(scratch, 'Briefs');
