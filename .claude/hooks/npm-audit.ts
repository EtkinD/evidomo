// PostToolUse hook for Bash: when Claude changes dependencies with npm, audit the tree and
// surface any advisory to Claude. Exit code 2 makes Claude Code show stderr to the model.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const DEPENDENCY_CHANGE =
  /(?:^|[\s;&|(])npm\s+(?:install|i|add|ci|update|up|upgrade|uninstall|un|remove|rm|r)(?:\s|$)/;

const hookInputSchema = z.object({
  tool_input: z.object({ command: z.string() }),
});

const auditReportSchema = z.object({
  vulnerabilities: z.record(
    z.string(),
    z.object({ severity: z.string(), fixAvailable: z.unknown() }),
  ),
  metadata: z.object({
    vulnerabilities: z.object({
      low: z.number(),
      moderate: z.number(),
      high: z.number(),
      critical: z.number(),
      total: z.number(),
    }),
  }),
});

function surface(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let rawInput: unknown;
try {
  rawInput = JSON.parse(readFileSync(0, 'utf8'));
} catch (error) {
  // Exit 1 is a non-blocking hook error: shown to the user, the tool call is unaffected.
  process.stderr.write(`npm-audit hook: unreadable hook input (${String(error)})\n`);
  process.exit(1);
}

const input = hookInputSchema.safeParse(rawInput);
if (!input.success || !DEPENDENCY_CHANGE.test(input.data.tool_input.command)) {
  process.exit(0);
}
const command = input.data.tool_input.command;

const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
const audit = spawnSync('npm', ['audit', '--json'], {
  cwd: projectDir,
  encoding: 'utf8',
  timeout: 90_000,
});
if (audit.error) {
  surface(`npm audit could not run after \`${command}\`: ${audit.error.message}`);
}

let report: z.infer<typeof auditReportSchema>;
try {
  report = auditReportSchema.parse(JSON.parse(audit.stdout));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  surface(
    `npm audit returned unreadable output after \`${command}\` (exit ${audit.status ?? 'unknown'}): ${reason}\n${audit.stderr.slice(0, 500)}`,
  );
}

const counts = report.metadata.vulnerabilities;
if (counts.total === 0) {
  process.exit(0);
}

const packages = Object.entries(report.vulnerabilities).map(
  ([name, entry]) =>
    `- ${name} (${entry.severity})${entry.fixAvailable === false ? ' — no fix available' : ''}`,
);
surface(
  [
    `npm audit found ${counts.total} vulnerabilities after \`${command}\` ` +
      `(critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low}):`,
    ...packages,
    'Resolve before continuing: upgrade, or add an npm override and verify the affected tool still works.',
    'Never run `npm audit fix --force`. Details: `npm audit`.',
  ].join('\n'),
);
