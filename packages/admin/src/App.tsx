/**
 * Admin shell. Google SSO, the source manager and the tagging queue arrive in
 * phase 5; this exists so the build pipeline and routing are wired from the start.
 */
export function App() {
  return (
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '2rem 1.25rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>ממשק ניהול</h1>
      <p>הממשק ייבנה בשלב 5. כרגע זהו שלד בלבד.</p>
    </main>
  );
}
