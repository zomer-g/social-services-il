import { useEffect, useState } from 'react';

/**
 * The developer page.
 *
 * Rendered from the live OpenAPI document rather than written by hand, so it
 * describes the instance serving it and cannot drift. Every endpoint carries a
 * runnable curl command, because the first thing anyone does with an API is try
 * one call and see the shape of the answer.
 */

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string; enum?: string[]; default?: unknown } }[];
  security?: unknown[];
  requestBody?: unknown;
}

interface Spec {
  info: { title: string; description: string; version: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Operation>>;
}

const EXAMPLES: Record<string, string> = {
  '/api/v1/search': "curl -G '%URL%/api/v1/search' \\\n  --data-urlencode 'q=מזון' \\\n  --data-urlencode 'lat=32.0853' --data-urlencode 'lon=34.7818' \\\n  --data-urlencode 'radius_km=10'",
  '/api/v1/taxonomy': "curl '%URL%/api/v1/taxonomy?axis=response&lang=he'",
  '/api/v1/autocomplete': "curl -G '%URL%/api/v1/autocomplete' --data-urlencode 'q=מזו'",
  '/api/v1/stats': "curl '%URL%/api/v1/stats'",
  '/api/v1/export/cards.ndjson': "curl '%URL%/api/v1/export/cards.ndjson?updated_since=2026-01-01T00:00:00Z'",
  '/api/v1/ingest/whoami': "curl '%URL%/api/v1/ingest/whoami' \\\n  -H 'Authorization: Bearer YOUR_KEY'",
  '/api/v1/ingest/services':
    "curl -X POST '%URL%/api/v1/ingest/services' \\\n" +
    "  -H 'Authorization: Bearer YOUR_KEY' \\\n" +
    "  -H 'content-type: application/json' \\\n" +
    "  -d '{\n" +
    '    \"dry_run\": true,\n' +
    '    \"services\": [{\n' +
    '      \"external_id\": \"my-service-1\",\n' +
    '      \"name\": \"חלוקת סלי מזון\",\n' +
    '      \"description\": \"סלי מזון שבועיים למשפחות במצוקה כלכלית.\",\n' +
    '      \"responses\": [\"human_services:food:food_delivery\"],\n' +
    '      \"situations\": [\"human_situations:deprivation:low_income\"],\n' +
    '      \"organization\": { \"id\": \"580000000\", \"name\": \"שם הארגון\" },\n' +
    '      \"branches\": [{\n' +
    '        \"external_id\": \"branch-1\",\n' +
    '        \"address\": \"הרצל 1, תל אביב\",\n' +
    '        \"city\": \"תל אביב יפו\",\n' +
    '        \"lat\": 32.06, \"lon\": 34.78,\n' +
    '        \"phone_numbers\": [\"03-0000000\"]\n' +
    '      }]\n' +
    "    }]\n  }'",
  '/mcp': "# In Claude Code:\nclaude mcp add --transport http social-services %URL%/mcp",
};

export function DevelopersPage() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = window.location.origin;

  useEffect(() => {
    fetch('/api/openapi.json')
      .then((r) => r.json())
      .then(setSpec)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="notice">{error}</p>;
  if (!spec) return <p className="empty"><span className="spinner" aria-hidden="true" /></p>;

  const byTag = spec.tags.map((tag) => ({
    tag,
    operations: Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, op]) => op.tags?.includes(tag.name))
        .map(([method, op]) => ({ path, method, op })),
    ),
  }));

  return (
    <div className="devdocs" dir="ltr" lang="en">
      <h1>{spec.info.title}</h1>
      <p className="version">Version {spec.info.version}</p>

      {spec.info.description.split('\n\n').map((para, i) =>
        para.startsWith('## ') ? (
          <h2 key={i}>{para.slice(3)}</h2>
        ) : (
          <p key={i}>{renderInline(para)}</p>
        ),
      )}

      <h2>Machine-readable</h2>
      <p>
        <a href="/api/openapi.json">/api/openapi.json</a> — the document this page is generated
        from.
      </p>

      {byTag.map(({ tag, operations }) =>
        operations.length === 0 ? null : (
          <section key={tag.name}>
            <h2>{tag.name}</h2>
            <p>{tag.description}</p>
            {operations.map(({ path, method, op }) => (
              <article key={`${method} ${path}`} className="endpoint">
                <h3>
                  <span className={`method ${method}`}>{method.toUpperCase()}</span>
                  <code>{path}</code>
                  {op.security && <span className="tag">key required</span>}
                </h3>
                {op.summary && <p className="summary">{op.summary}</p>}
                {op.description?.split('\n\n').map((para, i) => <p key={i}>{renderInline(para)}</p>)}

                {op.parameters && op.parameters.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>Parameter</th>
                        <th>Type</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {op.parameters.map((p) => (
                        <tr key={p.name}>
                          <td>
                            <code>{p.name}</code>
                            {p.required && <span className="req"> required</span>}
                          </td>
                          <td>
                            {p.schema?.enum ? p.schema.enum.join(' | ') : (p.schema?.type ?? 'string')}
                            {p.schema?.default !== undefined && ` (${String(p.schema.default)})`}
                          </td>
                          <td>{p.description ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {EXAMPLES[path] && <CodeBlock code={EXAMPLES[path].replaceAll('%URL%', base)} />}
              </article>
            ))}
          </section>
        ),
      )}
    </div>
  );
}

/**
 * Renders the two bits of Markdown the spec's prose actually uses — code spans
 * and bold — without pulling in a parser. Anything else is left as written.
 */
function renderInline(text: string) {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i}>{part}</code>
    ) : (
      <span key={i}>
        {part.split('**').map((bit, j) => (j % 2 === 1 ? <strong key={j}>{bit}</strong> : bit))}
      </span>
    ),
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <button
        type="button"
        className="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
