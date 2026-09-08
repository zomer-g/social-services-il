import { useEffect, useState } from 'react';

interface Health {
  status: string;
  checks: Record<string, string>;
  version: string;
}

/**
 * Placeholder shell. The search experience lands in phase 3; for now this
 * proves the built SPA is served by the API container and can reach the API.
 */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="shell">
      <h1>כל השירותים החברתיים</h1>
      <p className="lede">
        פלטפורמה פתוחה לחיפוש שירותים חברתיים בישראל — עם API מתועד ושרת MCP.
      </p>
      <section className="status" aria-live="polite">
        <h2>מצב המערכת</h2>
        {error && <p className="err">שגיאה: {error}</p>}
        {!health && !error && <p>בודק…</p>}
        {health && (
          <dl>
            <dt>סטטוס</dt>
            <dd>{health.status}</dd>
            {Object.entries(health.checks).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <dt>גרסה</dt>
            <dd>{health.version}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
