/** PostgreSQL TEXT cannot store NUL or lone surrogates. Store a canonical JSON
 * string as TEXT, never as jsonb, and decode only in JavaScript. */
export function encodeLearningText(text: string): string {
  if (typeof text !== "string" || text.length > 30000)
    throw new Error("Learning writing unavailable");
  return JSON.stringify(text);
}

export function decodeLearningText(encoded: string): string {
  const text: unknown = JSON.parse(encoded);
  if (typeof text !== "string" || encodeLearningText(text) !== encoded)
    throw new Error("Learning writing unavailable");
  return text;
}
