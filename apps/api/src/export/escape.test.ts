import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escape.ts';
import { exportArtifactId } from './ids.ts';

describe('escapeHtml', () => {
  it('escapes the five characters that matter in content and quoted attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;',
    );
  });

  it('escapes an existing entity again instead of trusting it', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('leaves other text, including non-ASCII and newlines, unchanged', () => {
    const text = 'Woonoppervlakte 92 m² — “licht”\nen ruim';
    expect(escapeHtml(text)).toBe(text);
    expect(escapeHtml('')).toBe('');
  });

  it('never lets a tag or an attribute break-out survive', () => {
    for (const payload of [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      "' onmouseover='alert(1)",
      '</style><script>x</script>',
    ]) {
      expect(escapeHtml(payload)).not.toMatch(/[<>"']/);
    }
  });
});

describe('exportArtifactId', () => {
  const runId = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';

  it('is a stable RFC 9562 version-8 UUID per run and file name', () => {
    const id = exportArtifactId(runId, 'photo-01.jpg');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(exportArtifactId(runId, 'photo-01.jpg')).toBe(id);
  });

  it('differs between files and between runs', () => {
    const ids = new Set([
      exportArtifactId(runId, 'photo-01.jpg'),
      exportArtifactId(runId, 'photo-01-staged.jpg'),
      exportArtifactId(runId, 'listing-pack.html'),
      exportArtifactId('9d7c3f4e-1b2a-4c5d-9e8f-7a6b5c4d3e2f', 'photo-01.jpg'),
    ]);
    expect(ids.size).toBe(4);
  });
});
