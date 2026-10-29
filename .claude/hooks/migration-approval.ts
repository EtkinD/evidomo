// PreToolUse hook for Bash: a new Drizzle migration needs the user's approval of its SQL before
// it is committed or merged (CLAUDE.md → Security, and the orchestrator's standing rule). When a
// `git commit` or `git merge` would add a file under apps/api/drizzle/, the hook asks the user;
// in modes that never ask (auto, dontAsk, bypassPermissions) it blocks instead, and the command
// passes only when it carries EVIDOMO_MIGRATION_APPROVED=1 after the user has approved in chat.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const MIGRATIONS_DIR = 'apps/api/drizzle';
const APPROVAL_TOKEN = 'EVIDOMO_MIGRATION_APPROVED=1';
const NON_ASKING_MODES = new Set(['auto', 'dontAsk', 'bypassPermissions']);

const hookInputSchema = z.object({
  cwd: z.string(),
  permission_mode: z.string().optional(),
  tool_input: z.object({ command: z.string() }),
});

let rawInput: unknown;
try {
  rawInput = JSON.parse(readFileSync(0, 'utf8'));
} catch (error) {
  // Exit 1 is a non-blocking hook error: shown to the user, the tool call is unaffected.
  process.stderr.write(`migration-approval hook: unreadable hook input (${String(error)})\n`);
  process.exit(1);
}

const input = hookInputSchema.safeParse(rawInput);
if (!input.success) process.exit(0);
const { command } = input.data.tool_input;
const commit = /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+commit\b/.test(command);
const merge = /(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+merge\b/.test(command);
if ((!commit && !merge) || command.includes(APPROVAL_TOKEN)) process.exit(0);

// The repository the command acts on: `git -C <dir>`, else a leading `cd <dir> &&`, else cwd.
const target =
  /git\s+-C\s+(\S+)/.exec(command)?.[1] ?? /^\s*cd\s+(\S+)\s*&&/.exec(command)?.[1] ?? '.';
const repoDir = path.resolve(input.data.cwd, target.replace(/^['"]|['"]$/g, ''));

function addedMigrations(args: readonly string[]): string[] {
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter((file) => file.startsWith(`${MIGRATIONS_DIR}/`));
}

const added = new Set<string>();
if (commit) {
  for (const file of addedMigrations(['--cached', '--', MIGRATIONS_DIR])) added.add(file);
  // `git add … && git commit` stages in the same command, after this hook has run.
  if (/(?:^|[\s;&|(])git(?:\s+-C\s+\S+)?\s+add\b/.test(command)) {
    const untracked = spawnSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', MIGRATIONS_DIR],
      { cwd: repoDir, encoding: 'utf8', timeout: 10_000 },
    );
    if (untracked.status === 0) {
      for (const file of untracked.stdout.split('\n')) if (file !== '') added.add(file);
    }
  }
  // `--amend` folds the staged changes into HEAD, so HEAD's own new migrations count too.
  if (/\s--amend\b/.test(command)) {
    for (const file of addedMigrations(['HEAD~1', 'HEAD', '--', MIGRATIONS_DIR])) added.add(file);
  }
}
if (merge) {
  // The merged ref is the last argument that is not an option.
  const ref = command
    .slice(command.search(/\bmerge\b/) + 'merge'.length)
    .split(/[;&|]/)[0]
    ?.trim()
    .split(/\s+/)
    .filter((arg) => arg !== '' && !arg.startsWith('-'))
    .at(-1);
  if (ref !== undefined) {
    for (const file of addedMigrations([`HEAD...${ref}`, '--', MIGRATIONS_DIR])) added.add(file);
  }
}
if (added.size === 0) process.exit(0);

const files = [...added].sort().join(', ');
const reason =
  `This ${commit ? 'commit' : 'merge'} adds a database migration (${files}). ` +
  'The user must approve its SQL first.';
if (NON_ASKING_MODES.has(input.data.permission_mode ?? '')) {
  process.stderr.write(
    `${reason} Show the user the SQL and wait for an explicit approval in chat; then re-run ` +
      `the command prefixed with ${APPROVAL_TOKEN}.\n`,
  );
  process.exit(2);
}
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }),
);
