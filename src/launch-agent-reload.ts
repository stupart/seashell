/**
 * Replaces the login agent from outside its job: refreshMeetingLaunchAgent
 * starts this in a session of its own, so booting the old job out does not
 * end it. Arguments: the installed plist and the user's id.
 */
import { dirname } from 'path';
import { replaceMeetingLaunchAgent } from './launch-at-login.ts';

const [plistPath, uid] = process.argv.slice(2);
try {
  if (!plistPath || !uid || !Number.isSafeInteger(Number(uid))) throw new Error('Usage: launch-agent-reload.ts <plist> <uid>');
  replaceMeetingLaunchAgent({ launchAgentsDir: dirname(plistPath), uid: Number(uid) });
} catch (error) {
  process.stderr.write(`${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
