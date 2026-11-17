import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'

const PERL = '/usr/bin/perl'
const PROBE_TIMEOUT_MS = 5_000
// libuv opens with no sharing under this flag, which Windows refuses while any handle is open.
const WINDOWS_EXCLUSIVE_OPEN = 0x10000000

// With the coordination lock held exclusively (as Codex holds it to sweep stale locks), each lock
// is tried without waiting and released at once: a writer starting meanwhile waits for
// coordination instead of failing. Coordination already taken leaves the answer unknown.
const PROBE = `
use Fcntl qw(:flock);
my ($coordination, @locks) = @ARGV;
$| = 1;
open(my $c, '+>>', $coordination) or do { print "unknown\\n"; exit 0 };
flock($c, LOCK_EX | LOCK_NB) or do { print "unknown\\n"; exit 0 };
for my $i (0 .. $#locks) {
  unless (open(my $l, '<', $locks[$i])) { next if $!{ENOENT}; print "unknown\\n"; exit 0 }
  else { if (flock($l, LOCK_EX | LOCK_NB)) { flock($l, LOCK_UN) } else { print "held $i\\n" } }
}
print "done\\n";
`

async function heldByFlock(coordination: string, locks: string[]): Promise<Set<string> | null> {
  if (!existsSync(PERL)) {
    return null
  }
  const result = await runProcess({
    program: PERL,
    args: ['-e', PROBE, '--', coordination, ...locks],
    timeoutMs: PROBE_TIMEOUT_MS
  }).catch(() => null)
  const lines = result?.stdout.split('\n') ?? []
  if (!result || result.code !== 0 || result.timedOut || !lines.includes('done')) {
    return null
  }
  const held = new Set<string>()
  for (const line of lines) {
    const index = /^held (\d+)$/.exec(line)?.[1]
    if (index !== undefined) {
      held.add(locks[Number(index)])
    }
  }
  return held
}

// Opening exclusively for an instant: a Codex opening that same file then gets a sharing error
// for that one start.
async function heldOnWindows(locks: string[]): Promise<Set<string>> {
  const held = new Set<string>()
  for (const path of locks) {
    try {
      await (await open(path, WINDOWS_EXCLUSIVE_OPEN)).close()
    } catch (error) {
      if (errnoCodeOrUnknown(error) !== 'ENOENT') {
        held.add(path)
      }
    }
  }
  return held
}

/**
 * Which of a Codex home's thread lock files some process holds; null when that can't be told. On
 * macOS and Linux the locks themselves are tried (whoever holds them: any user, PID namespace or
 * NFS client) under the home's coordination lock, which also reads as unknown while a Codex holds
 * it to publish without any thread lock.
 */
export function findHeldCodexLocks(
  coordination: string,
  locks: string[]
): Promise<Set<string> | null> {
  return process.platform === 'win32' ? heldOnWindows(locks) : heldByFlock(coordination, locks)
}
