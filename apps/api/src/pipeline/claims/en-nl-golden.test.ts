import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readNumbers, type ClaimLanguage, type NumberToken } from './numbers.ts';

// English and Dutch must read numbers exactly as they did before Turkish, Italian, and Spanish
// were added (the rules version stayed 1). `__tests__/en-nl-readings.golden.json` holds the
// readings of the numbers.ts that shipped en and nl only, over a deterministic corpus of
// synthetic text: prose from the committed Meta fixtures, the strings of the claim and Q&A test
// tables, and a grid of number forms (including the tr/it/es ones) in en/nl sentence frames.
// Regenerate it only for a deliberate en/nl rules change, together with a new rules version.

const GOLDEN = new URL('./__tests__/en-nl-readings.golden.json', import.meta.url);

const compactToken = z.tuple([
  z.number(),
  z.number(),
  z.union([
    z.tuple([z.number(), z.string().nullable()]),
    z.literal('unreadable'),
    z.literal('datetime'),
  ]),
  z.number().nullable(),
  z.boolean(),
  z.number().nullable(),
]);
const goldenSchema = z.object({
  generatedWith: z.string(),
  token: z.string(),
  entries: z.array(
    z.object({ text: z.string(), en: z.array(compactToken), nl: z.array(compactToken) }),
  ),
});

function compact(token: NumberToken): z.infer<typeof compactToken> {
  const { reading } = token;
  return [
    token.start,
    token.end,
    reading.kind === 'value' ? [reading.value, reading.unit] : reading.kind,
    token.approximateFrom,
    token.approximateSuffix,
    token.rangeTo,
  ];
}

describe('en and nl readings', () => {
  it('equal the golden readings from before tr, it, and es', async () => {
    const golden = goldenSchema.parse(JSON.parse(await readFile(GOLDEN, 'utf8')));
    expect(golden.entries.length).toBeGreaterThan(3000);
    const changed: string[] = [];
    for (const entry of golden.entries) {
      for (const language of ['en', 'nl'] as const satisfies readonly ClaimLanguage[]) {
        const now = readNumbers(entry.text, language).map(compact);
        if (JSON.stringify(now) !== JSON.stringify(entry[language])) {
          changed.push(`${language}: ${entry.text.slice(0, 80)}`);
        }
      }
    }
    expect(changed).toEqual([]);
  });
});
