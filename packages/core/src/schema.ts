/**
 * Checking a model's JSON answer against a schema, without the API doing it.
 *
 * Structured outputs would enforce the shape at generation time, and for a small
 * schema that is the right tool. The agreement extraction is not small: nested
 * services, each with an organization and a list of branches, every key
 * required. The API compiles that into a grammar, and refuses the request when
 * the grammar is too large — before the model has read a word.
 *
 * So the shape is held by the prompt, which carries the schema, and checked
 * here afterwards. This implements only the subset that schema uses — type,
 * enum, anyOf, properties, required, additionalProperties: false, items — and
 * says so rather than pretending to be a general validator: a keyword it does
 * not know is a mistake in the schema, not something to skip silently.
 */

export interface JsonSchema {
  type?: string | undefined;
  enum?: unknown[] | undefined;
  anyOf?: JsonSchema[] | undefined;
  properties?: Record<string, JsonSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
  items?: JsonSchema | undefined;
  description?: string | undefined;
}

const KNOWN = new Set(['type', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'description']);

/**
 * Every way `value` fails `schema`, as `$.path: what is wrong` lines, capped so
 * a wholly wrong answer does not produce a thousand of them. An empty list means
 * it validates.
 */
export function schemaErrors(schema: JsonSchema, value: unknown, limit = 50): string[] {
  const errors: string[] = [];
  visit(schema, value, '$', errors, limit);
  return errors;
}

function visit(schema: JsonSchema, value: unknown, path: string, errors: string[], limit: number): void {
  if (errors.length >= limit) return;

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`schemaErrors does not implement "${key}" (at ${path})`);
  }

  if (schema.anyOf) {
    if (!schema.anyOf.some((branch) => schemaErrors(branch, value, 1).length === 0)) {
      errors.push(`${path}: expected ${schema.anyOf.map((b) => b.type ?? 'a schema').join(' or ')}, got ${typeOf(value)}`);
    }
    return;
  }

  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}: missing "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}: unexpected "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in record) visit(sub, record[key], `${path}.${key}`, errors, limit);
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    const items = schema.items;
    value.forEach((item, i) => visit(items, item, `${path}[${i}]`, errors, limit));
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  // JSON has one number type; an integer is a number.
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

/**
 * The JSON object in a model's reply.
 *
 * Asked for "one JSON object and nothing else", a model still occasionally
 * wraps it in a code fence or a sentence. That is a formatting slip, not a wrong
 * answer, and is not worth a second billed turn: the object is taken from the
 * first opening brace to the last closing one.
 */
export function parseJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'The reply contains no JSON object.' };
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)) as unknown };
  } catch (err) {
    return { ok: false, error: `The reply is not valid JSON: ${(err as Error).message}` };
  }
}
