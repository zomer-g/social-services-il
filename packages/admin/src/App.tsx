import { useCallback, useEffect, useState } from 'react';
import './admin.css';

/**
 * The admin.
 *
 * Organised around the questions a content team actually has, in the order they
 * have them: what is live right now, what is waiting for me, what is broken, and
 * what are people failing to find. Entity editing sits behind those, because on
 * a corpus of this kind the scarce resource is attention, not forms.
 *
 * Sign-in is Google with invitations. The bootstrap token is accepted too, since
 * it is how the first administrator gets invited and how automated checks run;
 * it is typed in here rather than stored, so it never sits in browser storage.
 */

const TABS = ['overview', 'review', 'reports', 'sources', 'mcp', 'keys', 'people', 'diagnostics'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  overview: 'סקירה',
  review: 'ממתין לאישור',
  reports: 'דיווחי טעויות',
  sources: 'מקורות',
  mcp: 'שרתי MCP',
  keys: 'מפתחות API',
  people: 'משתמשים',
  diagnostics: 'אבחון',
};

let bootstrapToken = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(bootstrapToken ? { authorization: `Bearer ${bootstrapToken}` } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message = (body as { message?: string })?.message ?? `שגיאה ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function App() {
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  const [ssoAvailable, setSsoAvailable] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [checking, setChecking] = useState(true);

  const check = useCallback(async () => {
    try {
      const status = await api<{ google_configured: boolean }>('/api/auth/status');
      setSsoAvailable(status.google_configured);
      const me = await api<{ user: { email: string; role: string } }>('/api/admin/me');
      setUser(me.user);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (checking) return <p className="muted">בודק…</p>;
  if (!user) return <SignIn ssoAvailable={ssoAvailable} onSignedIn={check} />;

  return (
    <>
      <header className="adminbar">
        <strong>ניהול · כל השירותים החברתיים</strong>
        <nav>
          {TABS.map((t) => (
            <button key={t} type="button" className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
        <span className="muted">
          {user.email} · {user.role}
        </span>
      </header>

      <main>
        {tab === 'overview' && <Overview />}
        {tab === 'review' && <Review />}
        {tab === 'reports' && <Reports />}
        {tab === 'sources' && <Sources />}
        {tab === 'mcp' && <McpServers />}
        {tab === 'keys' && <Keys />}
        {tab === 'people' && <People />}
        {tab === 'diagnostics' && <Diagnostics />}
      </main>
    </>
  );
}

function SignIn({ ssoAvailable, onSignedIn }: { ssoAvailable: boolean; onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="signin">
      <h1>ניהול</h1>
      {ssoAvailable ? (
        <a className="btn" href="/api/auth/google">
          כניסה עם Google
        </a>
      ) : (
        <p className="muted">
          כניסה עם Google עדיין לא הוגדרה. יש להגדיר את משתני הסביבה
          <code> GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> ו־<code>SESSION_SECRET</code>.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          bootstrapToken = token.trim();
          setError(null);
          api('/api/admin/me')
            .then(onSignedIn)
            .catch((err: Error) => {
              bootstrapToken = '';
              setError(err.message);
            });
        }}
      >
        <label htmlFor="token">או מפתח ניהול זמני</label>
        <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        <button type="submit" className="btn secondary">
          כניסה
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

function useLoad<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api<T>(path)
      .then(setData)
      .catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, error, reload: () => setNonce((n) => n + 1) };
}

function Overview() {
  const { data, error, reload } = useLoad<Record<string, number | string | null>>('/api/admin/overview');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rebuild = async () => {
    setBusy(true);
    try {
      const r = await api<{ cards: number; duration_ms: number }>('/api/admin/rebuild', { method: 'POST' });
      setMessage(`נבנו ${r.cards} כרטיסים ב־${r.duration_ms} מילישניות`);
      reload();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;

  const cards: { label: string; key: string; warn?: boolean }[] = [
    { label: 'כרטיסים פעילים', key: 'cards' },
    { label: 'שירותים מפורסמים', key: 'services_published' },
    { label: 'שירותים בטיוטה', key: 'services_draft', warn: true },
    { label: 'ארגונים', key: 'organizations' },
    { label: 'ממתין לאישור', key: 'pending_review', warn: true },
    { label: 'דיווחי טעויות פתוחים', key: 'open_reports', warn: true },
    { label: 'כתובות שלא נפתרו', key: 'unresolved_locations', warn: true },
    { label: 'חיפושים ללא תוצאה (30 יום)', key: 'empty_searches_30d', warn: true },
  ];

  return (
    <>
      <h1>סקירה</h1>

      {data['rebuild_pending'] && (
        <p className="banner">
          יש שינויים שטרם נכנסו לתוצאות החיפוש ({String(data['rebuild_pending'])}).
        </p>
      )}

      <div className="stats">
        {cards.map((c) => (
          <div key={c.key} className={`stat ${c.warn && Number(data[c.key]) > 0 ? 'warn' : ''}`}>
            <span className="value">{String(data[c.key] ?? 0)}</span>
            <span className="label">{c.label}</span>
          </div>
        ))}
      </div>

      <p className="muted">
        עודכן לאחרונה: {data['last_updated'] ? new Date(String(data['last_updated'])).toLocaleString('he-IL') : '—'}
      </p>

      <div className="actions">
        <button type="button" className="btn" onClick={rebuild} disabled={busy}>
          {busy ? 'בונה…' : 'בנייה מחדש של הכרטיסים'}
        </button>
      </div>
      <p className="muted">
        עריכות בשירותים, בסניפים ובתיוגים אינן משפיעות על החיפוש הציבורי עד לבנייה מחדש.
      </p>
      {message && <p className="banner">{message}</p>}
    </>
  );
}

function Review() {
  const { data, error, reload } = useLoad<{ pending: Record<string, string>[] }>('/api/admin/moderation');

  const decide = async (id: string, decision: 'accept' | 'reject') => {
    await api(`/api/admin/moderation/${id}?decision=${decision}`, { method: 'POST' });
    reload();
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;
  if (data.pending.length === 0) return <p className="muted">אין פריטים הממתינים לאישור.</p>;

  return (
    <>
      <h1>ממתין לאישור</h1>
      <p className="muted">
        פריטים שהגיעו ממקורות שרמת האמון שלהם נמוכה מסף הפרסום האוטומטי, או מהציבור.
      </p>
      <table>
        <thead>
          <tr>
            <th>שם</th>
            <th>סוג</th>
            <th>מקור</th>
            <th>התקבל</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.pending.map((row) => (
            <tr key={row['id']}>
              <td>{row['name'] ?? row['entity_id']}</td>
              <td>{row['kind']}</td>
              <td>{row['source'] ?? row['submitted_by']}</td>
              <td>{new Date(row['created_at']!).toLocaleDateString('he-IL')}</td>
              <td className="rowactions">
                <button type="button" className="btn small" onClick={() => decide(row['id']!, 'accept')}>
                  אישור
                </button>
                <button type="button" className="btn small secondary" onClick={() => decide(row['id']!, 'reject')}>
                  דחייה
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Reports() {
  const { data, error, reload } = useLoad<{ reports: Record<string, string>[] }>('/api/admin/reports');

  const resolve = async (id: string, status: string) => {
    await api(`/api/admin/reports/${id}?status=${status}`, { method: 'POST' });
    reload();
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;
  if (data.reports.length === 0) return <p className="muted">אין דיווחים פתוחים.</p>;

  return (
    <>
      <h1>דיווחי טעויות</h1>
      <p className="muted">
        דיווחים מהציבור. מי שהתקשר לטלפון מנותק הוא היחיד שיודע שהוא מנותק.
      </p>
      {data.reports.map((r) => (
        <article key={r['id']} className="report">
          <h3>{r['service_name'] ?? r['card_id']}</h3>
          <p className="muted">{r['organization_name']}</p>
          <p>{r['message']}</p>
          <p className="muted">
            {new Date(r['created_at']!).toLocaleString('he-IL')}
            {r['contact'] && ` · ${r['contact']}`}
          </p>
          <div className="rowactions">
            <button type="button" className="btn small" onClick={() => resolve(r['id']!, 'fixed')}>
              טופל
            </button>
            <button type="button" className="btn small secondary" onClick={() => resolve(r['id']!, 'acknowledged')}>
              נקרא
            </button>
            <button type="button" className="btn small secondary" onClick={() => resolve(r['id']!, 'rejected')}>
              לא רלוונטי
            </button>
          </div>
        </article>
      ))}
    </>
  );
}

function Sources() {
  const { data, error, reload } = useLoad<{ sources: Record<string, string | number | boolean>[] }>('/api/admin/sources');
  const [form, setForm] = useState({ slug: '', name: '', kind: 'http_json', trust_level: 50 });
  const [message, setMessage] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/admin/sources', { method: 'POST', body: JSON.stringify(form) });
      setForm({ slug: '', name: '', kind: 'http_json', trust_level: 50 });
      setMessage(null);
      reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <h1>מקורות</h1>
      <p className="muted">
        רמת האמון קובעת מה קורה לנתונים שנדחפים במפתח המשויך למקור: מעל 70 הם מתפרסמים מיד, מתחת לכך
        הם ממתינים לאישור אנושי. הזנה של משרד ממשלתי וטופס באינטרנט אינן אותה טענה.
      </p>

      <form className="inline" onSubmit={create}>
        <input placeholder="slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
        <input placeholder="שם" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          {['http_json', 'csv_upload', 'google_sheet', 'ckan', 'guidestar', 'over', 'webhook', 'manual'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          max={100}
          value={form.trust_level}
          onChange={(e) => setForm({ ...form, trust_level: Number(e.target.value) })}
          aria-label="רמת אמון"
        />
        <button type="submit" className="btn">
          הוספה
        </button>
      </form>
      {message && <p className="error">{message}</p>}

      {!data ? (
        <p className="muted">טוען…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>מקור</th>
              <th>סוג</th>
              <th>אמון</th>
              <th>שירותים</th>
              <th>מפתחות</th>
              <th>ריצה אחרונה</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={String(s['id'])}>
                <td>
                  <strong>{String(s['name'])}</strong>
                  <br />
                  <code>{String(s['slug'])}</code>
                </td>
                <td>{String(s['kind'])}</td>
                <td>
                  {String(s['trust_level'])}
                  {Number(s['trust_level']) >= 70 ? ' · מתפרסם מיד' : ' · לאישור'}
                </td>
                <td>{String(s['services'])}</td>
                <td>{String(s['active_keys'])}</td>
                <td>{s['last_run_at'] ? new Date(String(s['last_run_at'])).toLocaleDateString('he-IL') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Keys() {
  const { data, error, reload } = useLoad<{ keys: Record<string, string>[] }>('/api/admin/keys');
  const sources = useLoad<{ sources: { slug: string; name: string }[] }>('/api/admin/sources');
  const [form, setForm] = useState({ name: '', source_slug: '' });
  const [minted, setMinted] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const created = await api<{ key: string }>('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ ...form, scopes: ['ingest:write'] }),
    });
    setMinted(created.key);
    setForm({ name: '', source_slug: '' });
    reload();
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <h1>מפתחות API</h1>
      <p className="muted">
        מפתח כתיבה משויך למקור, וכל מה שנדחף דרכו מיוחס אליו ויורש את רמת האמון שלו.
      </p>

      <form className="inline" onSubmit={create}>
        <input placeholder="שם המפתח" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select value={form.source_slug} onChange={(e) => setForm({ ...form, source_slug: e.target.value })} required>
          <option value="">בחירת מקור…</option>
          {(sources.data?.sources ?? []).map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn">
          יצירה
        </button>
      </form>

      {minted && (
        <div className="banner">
          <p>
            <strong>זו הפעם היחידה שהמפתח מוצג.</strong> יש להעתיק אותו עכשיו — במסד הנתונים נשמר רק
            גיבוב שלו.
          </p>
          <code className="secret">{minted}</code>
        </div>
      )}

      {!data ? (
        <p className="muted">טוען…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>שם</th>
              <th>מקור</th>
              <th>קידומת</th>
              <th>שימוש אחרון</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.keys.map((k) => (
              <tr key={k['id']} className={k['revoked_at'] ? 'revoked' : ''}>
                <td>{k['name']}</td>
                <td>{k['source'] ?? '—'}</td>
                <td>
                  <code>{k['key_prefix']}…</code>
                </td>
                <td>{k['last_used_at'] ? new Date(k['last_used_at']).toLocaleString('he-IL') : 'לא בשימוש'}</td>
                <td>
                  {k['revoked_at'] ? (
                    <span className="muted">בוטל</span>
                  ) : (
                    <button
                      type="button"
                      className="btn small secondary"
                      onClick={async () => {
                        await api(`/api/admin/keys/${k['id']}`, { method: 'DELETE' });
                        reload();
                      }}
                    >
                      ביטול
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function People() {
  const { data, error, reload } = useLoad<{
    invites: Record<string, string>[];
    users: Record<string, string | boolean>[];
  }>('/api/admin/invites');
  const [form, setForm] = useState({ email: '', role: 'editor' });
  const [message, setMessage] = useState<string | null>(null);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ note: string }>('/api/admin/invites', { method: 'POST', body: JSON.stringify(form) });
      setMessage(r.note);
      setForm({ email: '', role: 'editor' });
      reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <h1>משתמשים</h1>
      <p className="muted">
        הגישה היא בהזמנה בלבד: חשבון Google שלא הוזמן נדחה גם אם ההזדהות הצליחה.
      </p>

      <form className="inline" onSubmit={invite}>
        <input
          type="email"
          placeholder="כתובת אימייל"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {['admin', 'editor', 'tagger', 'org_manager', 'viewer'].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit" className="btn">
          הזמנה
        </button>
      </form>
      {message && <p className="banner">{message}</p>}

      {!data ? (
        <p className="muted">טוען…</p>
      ) : (
        <>
          <h2>משתמשים פעילים</h2>
          <table>
            <thead>
              <tr>
                <th>אימייל</th>
                <th>תפקיד</th>
                <th>כניסה אחרונה</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={String(u['id'])}>
                  <td>{String(u['email'])}</td>
                  <td>{String(u['role'])}</td>
                  <td>{u['last_login_at'] ? new Date(String(u['last_login_at'])).toLocaleString('he-IL') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>הזמנות ממתינות</h2>
          {data.invites.filter((i) => !i['accepted_at']).length === 0 ? (
            <p className="muted">אין.</p>
          ) : (
            <ul>
              {data.invites
                .filter((i) => !i['accepted_at'])
                .map((i) => (
                  <li key={i['id']}>
                    {i['email']} · {i['role']} · בתוקף עד{' '}
                    {new Date(i['expires_at']!).toLocaleDateString('he-IL')}
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function Diagnostics() {
  const rejections = useLoad<{ rejections: Record<string, string>[] }>('/api/admin/rejections');
  const gaps = useLoad<{ gaps: Record<string, string | number>[] }>('/api/admin/gaps');
  const [term, setTerm] = useState('');
  const [explained, setExplained] = useState<Record<string, unknown> | null>(null);

  return (
    <>
      <h1>אבחון</h1>

      <h2>למה שירותים לא מופיעים</h2>
      <p className="muted">
        שורות שנשמטו בבנייה האחרונה. כרטיס בלי מענה מתויג אינו נגיש בשום מסלול באתר, וכרטיס בלי מיקום
        תקין ושאינו ארצי לא יכול לענות על השאלה "לאן ללכת".
      </p>
      {!rejections.data ? (
        <p className="muted">טוען…</p>
      ) : rejections.data.rejections.length === 0 ? (
        <p className="muted">שום שורה לא נשמטה.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>שירות</th>
              <th>סיבה</th>
              <th>פירוט</th>
            </tr>
          </thead>
          <tbody>
            {rejections.data.rejections.slice(0, 50).map((r, i) => (
              <tr key={i}>
                <td>{r['service_name'] ?? r['service_id']}</td>
                <td>
                  {r['reason'] === 'no_response_tag' ? 'אין תיוג מענה' : 'מיקום לא נפתר'}
                </td>
                <td className="muted">{r['detail']}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>מה מחפשים ולא מוצאים</h2>
      <p className="muted">
        העדות הישירה ביותר למה שחסר במאגר. זו בעיית תוכן, לא בעיית קוד.
      </p>
      {!gaps.data ? (
        <p className="muted">טוען…</p>
      ) : gaps.data.gaps.length === 0 ? (
        <p className="muted">כל החיפושים האחרונים החזירו תוצאות.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>חיפוש</th>
              <th>פעמים</th>
              <th>לאחרונה</th>
            </tr>
          </thead>
          <tbody>
            {gaps.data.gaps.slice(0, 40).map((g, i) => (
              <tr key={i}>
                <td>{String(g['example'] ?? g['normalized'])}</td>
                <td>{String(g['searches'])}</td>
                <td>{new Date(String(g['last_seen'])).toLocaleDateString('he-IL')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>בדיקת חיפוש</h2>
      <p className="muted">
        מראה מה קורה לביטוי בכל שלב — פירוק למילים, נרמול, בניית השאילתה, והתאמות במדד ובטריגרם.
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          api<Record<string, unknown>>(`/api/admin/explain?q=${encodeURIComponent(term)}`).then(setExplained);
        }}
      >
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="ביטוי לבדיקה" />
        <button type="submit" className="btn">
          בדיקה
        </button>
      </form>
      {explained && <pre className="explain">{JSON.stringify(explained, null, 2)}</pre>}
    </>
  );
}

/**
 * The MCP servers the site's own search can reach.
 *
 * This is the screen that makes adding a data source a configuration change
 * rather than a deploy: an MCP server describes its own tools, so a URL and a
 * credential are the whole integration.
 */
function McpServers() {
  const { data, error, reload } = useLoad<{ servers: Record<string, string | number | boolean | null>[] }>(
    '/api/admin/mcp-servers',
  );
  const [form, setForm] = useState({ slug: '', name: '', url: '', description: '', auth_header: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; tools: string[]; error?: string }>>({});

  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api<{ ok: boolean; tools: string[]; error?: string }>(
        `/api/admin/mcp-servers/${id}/test`,
        { method: 'POST' },
      );
      setResults((current) => ({ ...current, [id]: r }));
      reload();
    } finally {
      setTesting(null);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/admin/mcp-servers', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          // An empty box means "leave the stored credential alone", not "clear it".
          auth_header: form.auth_header.trim() || undefined,
          enabled: false,
        }),
      });
      setForm({ slug: '', name: '', url: '', description: '', auth_header: '' });
      setMessage('נוסף. מומלץ לבדוק חיבור לפני הפעלה.');
      reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <>
      <h1>שרתי MCP</h1>
      <p className="muted">
        כל שרת רשום כאן הופך למקור שהחיפוש באתר יכול לתשאל. שרת MCP מתאר את הכלים של עצמו, ולכן
        כתובת ומפתח הם כל האינטגרציה — בלי לכתוב קוד ובלי פריסה מחדש.
      </p>
      <p className="muted">
        כפתור "חיפוש בכל המקורות" באתר מופיע רק כששני שרתים או יותר מופעלים. עם מקור אחד הוא היה
        משכפל את החיפוש החכם.
      </p>

      <form className="inline" onSubmit={add}>
        <input placeholder="slug (אותיות קטנות)" value={form.slug}
          onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
        <input placeholder="שם לתצוגה" value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input placeholder="https://.../mcp" value={form.url} dir="ltr"
          onChange={(e) => setForm({ ...form, url: e.target.value })} required />
        <input placeholder="Authorization (אופציונלי)" value={form.auth_header} dir="ltr"
          onChange={(e) => setForm({ ...form, auth_header: e.target.value })} />
        <button type="submit" className="btn">הוספה</button>
      </form>
      {message && <p className="banner">{message}</p>}

      {!data ? (
        <p className="muted">טוען…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>שרת</th>
              <th>מצב</th>
              <th>בדיקה אחרונה</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.servers.map((server) => {
              const id = String(server['id']);
              const result = results[id];
              return (
                <tr key={id} className={server['enabled'] ? '' : 'revoked'}>
                  <td>
                    <strong>{String(server['name'])}</strong>
                    <br />
                    <code dir="ltr">{String(server['url'])}</code>
                    {server['description'] && (
                      <>
                        <br />
                        <span className="muted">{String(server['description']).slice(0, 120)}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {server['enabled'] ? 'מופעל' : 'כבוי'}
                    {server['is_self'] ? ' · המאגר של האתר' : ''}
                    {server['has_credential'] ? ' · עם מפתח' : ''}
                  </td>
                  <td>
                    {server['last_checked_at'] ? (
                      <>
                        {new Date(String(server['last_checked_at'])).toLocaleString('he-IL')}
                        <br />
                        {server['last_status'] === 'ok' ? (
                          <span>תקין · {String(server['tool_count'])} כלים</span>
                        ) : (
                          <span className="error">{String(server['last_status']).slice(0, 90)}</span>
                        )}
                      </>
                    ) : (
                      <span className="muted">לא נבדק</span>
                    )}
                    {result?.ok && (
                      <>
                        <br />
                        <span className="muted">{result.tools.join(', ')}</span>
                      </>
                    )}
                  </td>
                  <td className="rowactions">
                    <button type="button" className="btn small secondary"
                      onClick={() => test(id)} disabled={testing === id}>
                      {testing === id ? 'בודק…' : 'בדיקת חיבור'}
                    </button>
                    <button type="button" className="btn small secondary"
                      onClick={async () => {
                        await api(`/api/admin/mcp-servers/${id}/toggle`, { method: 'POST' });
                        reload();
                      }}>
                      {server['enabled'] ? 'כיבוי' : 'הפעלה'}
                    </button>
                    {!server['is_self'] && (
                      <button type="button" className="btn small secondary"
                        onClick={async () => {
                          await api(`/api/admin/mcp-servers/${id}`, { method: 'DELETE' });
                          reload();
                        }}>
                        מחיקה
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
