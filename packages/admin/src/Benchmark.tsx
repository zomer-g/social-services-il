import { useEffect, useMemo, useState } from 'react';
import { api, download, useLoad } from './App';
import { parseQueries } from './queries';

/**
 * The benchmark tab.
 *
 * A list of queries, each with the answer someone decided is right, put to the
 * three search doors of the home page — the search box, the smart search and
 * the free-language question. The server runs them in the background and keeps
 * every result list in order; this screen shows, per interface, how often the
 * right answer came first, in the top three and in the top ten, and the CSV has
 * every list in full.
 *
 * Queries arrive pasted from a spreadsheet (two columns: query, expected) or as
 * a CSV file. The expected answer is one or more card or service ids; a query
 * without one is still run and recorded, just not scored.
 */

type Mode = 'quick' | 'smart' | 'free';
const MODES: Mode[] = ['quick', 'smart', 'free'];
const MODE_LABELS: Record<Mode, string> = {
  quick: 'חיפוש מהיר',
  smart: 'חיפוש חכם',
  free: 'שפה חופשית',
};

type Status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
const STATUS_LABELS: Record<Status, string> = {
  queued: 'בתור',
  running: 'רץ',
  done: 'הסתיים',
  failed: 'נכשל',
  cancelled: 'בוטל',
};

interface RunSummary {
  id: string;
  name: string;
  lang: string;
  modes: Mode[];
  status: Status;
  total: number;
  done: number;
  queries: number;
  error: string | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

interface Hit {
  card_id: string;
  service_id: string;
  service_name: string;
  organization_name: string;
  branch_name: string | null;
  city: string | null;
}

interface CellView {
  rank: number | null;
  count: number;
  total: number | null;
  top: Hit[];
  answer: string | null;
  error: string | null;
  duration_ms: number | null;
}

interface ModeSummary {
  mode: Mode;
  cells: number;
  errors: number;
  empty: number;
  judged: number;
  found: number;
  hit1: number;
  hit3: number;
  hit10: number;
  mrr: number | null;
  avg_ms: number | null;
}

interface RunDetail {
  run: RunSummary & { queries: { query: string; expected: string[] }[] };
  summary: ModeSummary[];
  rows: { query_no: number; query: string; expected: string[]; cells: Partial<Record<Mode, CellView | null>> }[];
}

export function Benchmark() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useLoad<{ runs: RunSummary[]; smart_available: boolean }>('/api/admin/benchmarks');
  const active = list.data?.runs.some((r) => r.status === 'queued' || r.status === 'running') ?? false;

  // Progress without a refresh button: poll while something is running.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(list.reload, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <>
      <h1>בנצ׳מרק</h1>
      <p className="muted">
        רשימת שאילתות קבועה, כל אחת עם התשובה הנכונה, שרצה ברקע בשלושת ממשקי החיפוש — חיפוש מהיר, חיפוש
        חכם ושפה חופשית. כל רשימת תוצאות נשמרת לפי הסדר, וניתן להוריד הכול כ־CSV.
      </p>

      <NewRun
        smartAvailable={list.data?.smart_available ?? true}
        onCreated={(id) => {
          list.reload();
          setSelected(id);
        }}
      />

      <h2>הרצות</h2>
      {list.error && <p className="error">{list.error}</p>}
      {!list.data && !list.error && <p className="muted">טוען…</p>}
      {list.data && list.data.runs.length === 0 && <p className="muted">עדיין אין הרצות.</p>}
      {list.data && list.data.runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>שם</th>
              <th>שאילתות</th>
              <th>ממשקים</th>
              <th>מצב</th>
              <th>התקדמות</th>
              <th>נוצר</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.runs.map((run) => (
              <tr key={run.id} className={run.id === selected ? 'selected' : ''}>
                <td>{run.name}</td>
                <td>{run.queries}</td>
                <td>{run.modes.map((m) => MODE_LABELS[m]).join(', ')}</td>
                <td>
                  <StatusPill status={run.status} />
                </td>
                <td>
                  {run.done}/{run.total}
                </td>
                <td>{new Date(run.created_at).toLocaleString('he-IL')}</td>
                <td className="rowactions">
                  <button type="button" className="btn small" onClick={() => setSelected(run.id)}>
                    פתיחה
                  </button>
                  <button
                    type="button"
                    className="btn small secondary"
                    onClick={() => void download(`/api/admin/benchmarks/${run.id}/export.csv`, 'benchmark.csv')}
                  >
                    CSV
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <RunView
          key={selected}
          id={selected}
          onChanged={list.reload}
          onSelect={setSelected}
        />
      )}
    </>
  );
}

function StatusPill({ status }: { status: Status }) {
  const tone = status === 'failed' ? 'bad' : status === 'cancelled' ? 'empty' : 'ok';
  return <span className={`pill ${tone}`}>{STATUS_LABELS[status]}</span>;
}

/* ------------------------------------------------------------------ new run */

function NewRun({ smartAvailable, onCreated }: { smartAvailable: boolean; onCreated: (id: string) => void }) {
  const [name, setName] = useState(() => `בנצ׳מרק ${new Date().toLocaleDateString('he-IL')}`);
  const [lang, setLang] = useState('he');
  const [modes, setModes] = useState<Mode[]>(MODES);
  const [text, setText] = useState('');
  // Commas separate columns only in a file that says it is CSV. In pasted text
  // a comma is part of the query: "סל מזון, ירושלים" is one search.
  const [csv, setCsv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => parseQueries(text, csv), [text, csv]);
  const judged = items.filter((i) => i.expected.length > 0).length;
  const modelModes = modes.filter((m) => m !== 'quick').length;

  const loadFile = async (file: File) => {
    setCsv(/\.csv$/i.test(file.name));
    setText(await file.text());
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (items.length === 0) {
      setError('לא נמצאו שאילתות.');
      return;
    }
    if (modes.length === 0) {
      setError('יש לבחור לפחות ממשק חיפוש אחד.');
      return;
    }
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>('/api/admin/benchmarks', {
        method: 'POST',
        body: JSON.stringify({ name, lang, modes, queries: items }),
      });
      setText('');
      setCsv(false);
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="panel" open>
      <summary>
        <strong>הרצה חדשה</strong>
      </summary>
      <form onSubmit={submit}>
        <div className="inline">
          <label>
            שם{' '}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          </label>
          <label>
            שפה{' '}
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="he">עברית</option>
              <option value="ar">ערבית</option>
              <option value="ru">רוסית</option>
              <option value="en">אנגלית</option>
            </select>
          </label>
        </div>

        <fieldset className="inline">
          <legend>ממשקי חיפוש</legend>
          {MODES.map((m) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                checked={modes.includes(m)}
                onChange={(e) =>
                  setModes((prev) => (e.target.checked ? [...prev, m] : prev.filter((x) => x !== m)))
                }
              />
              {MODE_LABELS[m]}
            </label>
          ))}
        </fieldset>
        {!smartAvailable && modelModes > 0 && (
          <p className="banner">
            לא מוגדר בשרת מפתח תקין ל־Anthropic או ל־Gemini, ולכן חיפוש חכם ושפה חופשית יירשמו כשגיאה.
          </p>
        )}

        <label htmlFor="bench-queries">
          <strong>שאילתות</strong>
        </label>
        <p className="muted">
          שורה לכל שאילתה. אפשר להדביק שתי עמודות מגיליון: השאילתה, ולצידה התשובה הנכונה — מזהה כרטיס
          (card_id) או מזהה שירות (service_id), וכמה מהם מופרדים ב־| או ב־;. אפשר גם לטעון קובץ CSV באותו מבנה,
          עם שורת כותרת או בלעדיה.
        </p>
        <textarea
          id="bench-queries"
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) setCsv(false);
          }}
          placeholder={'סל מזון בירושלים\ta1b2c3d4\nקייטנה לילדים עם מוגבלות\tsrv-123 | srv-456'}
          dir="auto"
          style={{ width: '100%' }}
        />
        <div className="actions">
          <label className="btn secondary">
            טעינת קובץ CSV
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = '';
              }}
            />
          </label>
          <button type="submit" className="btn" disabled={busy || items.length === 0 || modes.length === 0}>
            {busy ? 'שולח…' : `הרצה ברקע (${items.length * modes.length} חיפושים)`}
          </button>
        </div>
        <p className="muted">
          {items.length} שאילתות, {judged} מהן עם תשובה נכונה.
          {modelModes > 0 && items.length > 0 && ' כל חיפוש חכם או בשפה חופשית הוא קריאה למודל, שלוקחת כמה שניות ועולה כסף.'}
        </p>
        {error && <p className="error">{error}</p>}
      </form>
    </details>
  );
}

/* ----------------------------------------------------------------- one run */

function RunView({ id, onChanged, onSelect }: { id: string; onChanged: () => void; onSelect: (id: string | null) => void }) {
  const { data, error, reload } = useLoad<RunDetail>(`/api/admin/benchmarks/${id}`);
  const [message, setMessage] = useState<string | null>(null);
  const running = data?.run.status === 'queued' || data?.run.status === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const act = async (fn: () => Promise<void>) => {
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;
  const { run, summary, rows } = data;

  return (
    <section className="panel">
      <h2>
        {run.name} <StatusPill status={run.status} />
      </h2>
      <p className="muted">
        {run.done}/{run.total} חיפושים · {run.queries.length} שאילתות · שפה: {run.lang}
        {run.created_by ? ` · ${run.created_by}` : ''}
        {run.finished_at ? ` · הסתיים ${new Date(run.finished_at).toLocaleString('he-IL')}` : ''}
      </p>
      {run.total > 0 && <progress max={run.total} value={run.done} style={{ width: '100%' }} />}
      {run.error && <p className="error">{run.error}</p>}

      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => act(() => download(`/api/admin/benchmarks/${run.id}/export.csv`, 'benchmark.csv'))}
        >
          הורדת CSV
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={() =>
            act(async () => {
              const r = await api<{ id: string }>(`/api/admin/benchmarks/${run.id}/rerun`, { method: 'POST' });
              onChanged();
              onSelect(r.id);
            })
          }
        >
          הרצה חוזרת
        </button>
        {running && (
          <button
            type="button"
            className="btn secondary"
            onClick={() =>
              act(async () => {
                await api(`/api/admin/benchmarks/${run.id}/cancel`, { method: 'POST' });
                reload();
                onChanged();
              })
            }
          >
            עצירה
          </button>
        )}
        <button
          type="button"
          className="btn secondary"
          onClick={() =>
            act(async () => {
              if (!window.confirm('למחוק את ההרצה ואת כל התוצאות שלה?')) return;
              await api(`/api/admin/benchmarks/${run.id}`, { method: 'DELETE' });
              onChanged();
              onSelect(null);
            })
          }
        >
          מחיקה
        </button>
      </div>
      {message && <p className="error">{message}</p>}

      <h3>סיכום לפי ממשק</h3>
      <table>
        <thead>
          <tr>
            <th>ממשק</th>
            <th>חיפושים</th>
            <th>שגיאות</th>
            <th>ללא תוצאות</th>
            <th>עם תשובה נכונה</th>
            <th>במקום 1</th>
            <th>ב־3 הראשונים</th>
            <th>ב־10 הראשונים</th>
            <th>נמצא בכלל</th>
            <th title="Mean Reciprocal Rank: ממוצע של 1 חלקי המקום של התשובה הנכונה">MRR</th>
            <th>זמן ממוצע</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((s) => (
            <tr key={s.mode}>
              <td>{MODE_LABELS[s.mode]}</td>
              <td>{s.cells}</td>
              <td>{s.errors}</td>
              <td>{s.empty}</td>
              <td>{s.judged}</td>
              <td>{share(s.hit1, s.judged)}</td>
              <td>{share(s.hit3, s.judged)}</td>
              <td>{share(s.hit10, s.judged)}</td>
              <td>{share(s.found, s.judged)}</td>
              <td>{s.mrr === null ? '—' : s.mrr.toFixed(3)}</td>
              <td>{s.avg_ms === null ? '—' : `${(s.avg_ms / 1000).toFixed(1)} ש׳`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>לפי שאילתה</h3>
      <p className="muted">
        המספר הוא המקום של התשובה הנכונה ברשימה. מתחתיו שלוש התוצאות הראשונות; הרשימה המלאה בקובץ ה־CSV.
      </p>
      <table className="compare">
        <thead>
          <tr>
            <th>#</th>
            <th>שאילתה</th>
            {run.modes.map((m) => (
              <th key={m}>{MODE_LABELS[m]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.query_no}>
              <td>{row.query_no}</td>
              <td>
                {row.query}
                {row.expected.length > 0 && (
                  <div className="muted">
                    <code>{row.expected.join(' | ')}</code>
                  </div>
                )}
              </td>
              {run.modes.map((m) => (
                <td key={m}>
                  <Cell cell={row.cells[m] ?? null} judged={row.expected.length > 0} expected={row.expected} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Cell({ cell, judged, expected }: { cell: CellView | null; judged: boolean; expected: string[] }) {
  if (!cell) return <span className="muted">ממתין…</span>;
  if (cell.error) {
    return (
      <>
        <span className="pill bad">שגיאה</span>
        <div className="muted" style={{ fontSize: '0.8rem', overflowWrap: 'anywhere' }}>
          {cell.error.slice(0, 200)}
        </div>
      </>
    );
  }
  return (
    <>
      {judged &&
        (cell.rank === null ? (
          <span className="pill bad">לא נמצא</span>
        ) : (
          <span className={`pill ${cell.rank <= 3 ? 'ok' : 'empty'}`}>מקום {cell.rank}</span>
        ))}{' '}
      <span className="muted">
        {cell.count} תוצאות{cell.total !== null && cell.total > cell.count ? ` מתוך ${cell.total}` : ''}
      </span>
      {cell.top.length > 0 && (
        <ol className="cardlist">
          {cell.top.slice(0, 3).map((hit) => (
            <li
              key={hit.card_id}
              style={
                expected.includes(hit.card_id) || expected.includes(hit.service_id)
                  ? { fontWeight: 700 }
                  : undefined
              }
            >
              {hit.service_name}
              <span className="muted">
                {' '}
                · {hit.organization_name}
                {hit.city ? ` · ${hit.city}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function share(n: number, of: number): string {
  if (of === 0) return '—';
  return `${n} (${Math.round((100 * n) / of)}%)`;
}
