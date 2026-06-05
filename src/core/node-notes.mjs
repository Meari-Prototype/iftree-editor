export const GENERATED_NOTE_START = '<!-- iftree:generated-note:start -->';
export const GENERATED_NOTE_END = '<!-- iftree:generated-note:end -->';

function cleanText(value) {
  return String(value || '').trim();
}

export function parseNodeNote(note) {
  const source = String(note || '');
  if (!source.trim()) return [];

  const segments = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(GENERATED_NOTE_START, cursor);
    if (start === -1) {
      const text = cleanText(source.slice(cursor));
      if (text) segments.push({ text, generated: false });
      break;
    }

    const manualText = cleanText(source.slice(cursor, start));
    if (manualText) segments.push({ text: manualText, generated: false });

    const contentStart = start + GENERATED_NOTE_START.length;
    const end = source.indexOf(GENERATED_NOTE_END, contentStart);
    if (end === -1) {
      const text = cleanText(source.slice(contentStart));
      if (text) segments.push({ text, generated: true });
      break;
    }

    const text = cleanText(source.slice(contentStart, end));
    if (text) segments.push({ text, generated: true });
    cursor = end + GENERATED_NOTE_END.length;
  }

  return segments;
}

export function plainNodeNote(note) {
  return parseNodeNote(note).map((segment) => segment.text).join('\n\n');
}

export function hasGeneratedNote(note) {
  return parseNodeNote(note).some((segment) => segment.generated && segment.text.trim());
}

export function appendGeneratedNote(note, generatedText) {
  const text = cleanText(generatedText);
  if (!text) return cleanText(note);
  return [
    cleanText(note),
    `${GENERATED_NOTE_START}\n${text}\n${GENERATED_NOTE_END}`
  ].filter(Boolean).join('\n\n');
}

export function mergeNodeNotes(...notes) {
  return notes.map(cleanText).filter(Boolean).join('\n\n');
}
