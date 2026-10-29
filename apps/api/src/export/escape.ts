// HTML escaping for the export's hand-built templates (no template library). Every interpolated
// string goes through `escapeHtml`, in text and in double-quoted attribute values alike: copy,
// fact values, labels, and office details are model or operator text and never trusted.

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes `& < > " '`, which makes the text safe in element content and quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}
