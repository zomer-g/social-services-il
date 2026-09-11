/**
 * The reading prompt, assembled.
 *
 * One function for the screen and the batch script, so the two cannot read the
 * same document with slightly different instructions and then disagree about
 * what it says.
 */

export interface TaxonomyLine {
  id: string;
  axis: string;
  depth: number;
  name: string | null;
}

export function buildReaderPrompt(input: {
  /** prompts/agreement-to-service.md, verbatim. */
  template: string;
  /** prompts/agreement-extraction.schema.json, verbatim. */
  schemaText: string;
  nodes: TaxonomyLine[];
  /** The date "expired" is judged against. */
  today: string;
}): string {
  const lines = (axis: string) =>
    input.nodes.filter((n) => n.axis === axis).map((n) => `${'  '.repeat(n.depth)}${n.id} — ${n.name ?? ''}`);
  const responses = lines('response');
  const situations = lines('situation');
  const taxonomy = [
    `RESPONSES — what the service provides (${responses.length}):`,
    ...responses,
    '',
    `SITUATIONS — who it is for (${situations.length}):`,
    ...situations,
  ].join('\n');

  // Everything after this heading is the document, which every provider takes
  // as its own part of the message rather than as text inside the instructions.
  const [instructions] = input.template.split('\n## The document');
  return (instructions ?? input.template)
    .replaceAll('{{TODAY}}', input.today)
    .replaceAll('{{TAXONOMY}}', taxonomy)
    .replaceAll('{{SCHEMA}}', input.schemaText);
}
