import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, useLoad } from './App';

/**
 * Reading agreements, with a choice of model, and with several at once.
 *
 * The screen exists to decide which model should read an archive of ten
 * thousand documents, and that decision has two halves that pull against each
 * other: what a document costs, and whether the reading is right. Neither can
 * be judged from one document or from a price list. So a document can be sent
 * to several models in parallel, their answers are laid side by side with the
 * disagreements marked, and every read is kept — so the totals at the bottom
 * are measured across everything tried, not remembered.
 *
 * Cost is projected from the *marginal* figure, not the first document's: the
 * prompt carries the whole taxonomy and is cached once per run, so the first
 * document overstates a batch, and multiplying it by ten thousand would
 * overstate the bill several times over.
 *
 * Nothing here reaches the public site. A service created from a reading is a
 * draft in the review queue, one click at a time.
 */

/* -------------------------------------------------------------------- types */

type Provider = 'anthropic' | 'openai' | 'google';
type Effort = 'low' | 'medium' | 'high';

interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelView {
  id: string;
  provider: Provider;
  label: string;
  tier: 'flagship' | 'balanced' | 'economy';
  prices: Prices;
  efforts: Effort[];
  note?: string;
  available: boolean;
  listed: boolean | null;
}

interface ProviderView {
  id: Provider;
  label: string;
  key_names: string[];
  configured: boolean;
  reachable: boolean | null;
  error?: string;
}

interface Catalog {
  prices_checked: string;
  default_model: string;
  max_bytes: number;
  max_models_per_batch: number;
  checked_at: string;
  providers: ProviderView[];
  models: ModelView[];
}

interface MatchCandidateView {
  service_id: string;
  card_id: string;
  service_name: string;
  organization_name: string;
  city: string | null;
  national_service: boolean;
  score: number;
  components: Record<string, number | null>;
  reasons: string[];
}

interface MatchView {
  decision: 'link' | 'review' | 'new';
  rationale: string[];
  best: MatchCandidateView | null;
  candidates: MatchCandidateView[];
}

interface ServiceView {
  external_id: string;
  name: string;
  description?: string | null;
  organization?: { name?: string | null; id?: string | null } | null;
  branches?: { city?: string | null; address?: string | null }[] | null;
  phone_numbers?: string[] | null;
  payment_required?: boolean | null;
  responses?: string[] | null;
  situations?: string[] | null;
  national_service?: boolean;
  source_quotes?: string[] | null;
  [key: string]: unknown;
}

interface DocumentView {
  external_id: string;
  title?: string | null;
  kind?: string | null;
  authority?: string | null;
  provider?: string | null;
  ends_on?: string | null;
}

interface ExtractionView {
  document: DocumentView;
  verdict: { decision: string; reason: string; subject: string; expired: boolean; confidence: number };
  services: ServiceView[];
  unmapped?: string[];
  questions?: string[];
}

interface RunView {
  id: string;
  batch_id: string;
  filename: string;
  document_bytes: number;
  document_kind: 'pdf' | 'text';
  provider: Provider;
  model: string;
  served_model: string | null;
  effort: Effort | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  usage: { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number | null };
  cost: { total?: number; marginal?: number };
  elapsed_ms: number | null;
  extraction: ExtractionView | null;
  warnings: string[];
  matches: (MatchView | null)[] | null;
  error: { kind: string; message: string; problems?: string[]; answer?: string } | null;
  created_at: string;
}

interface BatchSummary {
  batch_id: string;
  filename: string;
  bytes: number;
  kind: string;
  created_at: string;
  pending: number;
  runs: {
    id: string;
    model: string;
    status: RunView['status'];
    decision: string | null;
    services: number;
    cost: number | null;
    marginal: number | null;
    error: string | null;
  }[];
}

interface ModelStats {
  model: string;
  provider: Provider;
  runs: number;
  done: number;
  failed: number;
  avg_marginal: number | null;
  avg_total: number | null;
  spent: number | null;
  avg_ms: number | null;
  avg_attempts: number | null;
  avg_bytes: number | null;
  agreement: { compared: number; agreed: number };
}

/* ------------------------------------------------------------------- labels */

const VERDICT_LABELS: Record<string, string> = {
  relevant: 'שירות לציבור',
  partial: 'שירות, אך חסר מידע',
  irrelevant: 'לא שירות לציבור',
};

const SUBJECT_LABELS: Record<string, string> = {
  service_to_public: 'שירות לציבור',
  goods: 'רכש טובין',
  works_or_construction: 'עבודות ובנייה',
  professional_services_to_the_authority: 'שירותים מקצועיים לרשות',
  staffing: 'כוח אדם ומיקור חוץ',
  property_or_finance: 'נכסים ומימון',
  internal_operations: 'תפעול פנימי',
  unclear: 'לא ברור',
};

const DECISION_LABELS: Record<string, string> = {
  link: 'קיים במאגר',
  review: 'דורש הכרעה',
  new: 'חדש למאגר',
};

const STATUS_LABELS: Record<RunView['status'], string> = {
  queued: 'ממתין',
  running: 'קורא…',
  done: 'הושלם',
  failed: 'נכשל',
};

const TIER_LABELS: Record<ModelView['tier'], string> = {
  flagship: 'מוביל',
  balanced: 'מאוזן',
  economy: 'חסכוני',
};

const EFFORT_LABELS: Record<Effort, string> = { low: 'נמוך', medium: 'בינוני', high: 'גבוה' };

const ERROR_LABELS: Record<string, string> = {
  not_configured: 'אין מפתח',
  unknown_model: 'המודל לא נמצא',
  rejected: 'הבקשה נדחתה',
  rate_limited: 'מגבלת קצב',
  unavailable: 'הספק לא זמין',
  too_large: 'המסמך גדול מדי',
  network: 'תקלת רשת',
  refused: 'המודל סירב',
  invalid_answer: 'תשובה לא תקינה',
  internal: 'שגיאה פנימית',
};

/* ---------------------------------------------------------------- storage */

/** Per-viewer conveniences only; the screen works the same without them. */
function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the choice simply is not remembered.
  }
}

/* --------------------------------------------------------------------- main */

export function Agreements() {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { data: catalog, error: catalogError } = useLoad<Catalog>(
    `/api/admin/agreements/models${refreshNonce ? '?refresh=1' : ''}`,
    [refreshNonce],
  );
  const [selected, setSelected] = useState<string[]>(() => stored('agreements.models', ['claude-opus-5']));
  const [effort, setEffort] = useState<Effort>(() => stored('agreements.effort', 'high'));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [rate, setRate] = useState('3.7');

  const { data: history } = useLoad<{ batches: BatchSummary[] }>('/api/admin/agreements/batches?limit=30', [historyNonce]);
  const { data: stats } = useLoad<{ models: ModelStats[] }>('/api/admin/agreements/stats', [historyNonce]);

  useEffect(() => store('agreements.models', selected), [selected]);
  useEffect(() => store('agreements.effort', effort), [effort]);

  // A model chosen earlier that has since become unavailable is not silently
  // sent; it stays ticked but greyed, and is left out of the request.
  const usable = useMemo(
    () => selected.filter((id) => catalog?.models.find((m) => m.id === id)?.available),
    [selected, catalog],
  );

  const refreshHistory = useCallback(() => setHistoryNonce((n) => n + 1), []);

  const submit = async (filename: string, body: Blob | string, contentType: string) => {
    setBusy(filename);
    setError(null);
    try {
      const params = new URLSearchParams({ filename, models: usable.join(','), effort });
      const result = await api<{ batch_id: string }>(`/api/admin/agreements/batches?${params.toString()}`, {
        method: 'POST',
        body,
        headers: { 'content-type': contentType },
      });
      setOpenBatch(result.batch_id);
      refreshHistory();
    } catch (err) {
      setError(`${filename}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (catalog && file.size > catalog.max_bytes) {
        setError(`${file.name}: ${(file.size / 1e6).toFixed(1)} מגה־בייט, מעל המגבלה של ${Math.round(catalog.max_bytes / 1e6)}. יש לפצל את הקובץ.`);
        continue;
      }
      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      await submit(file.name, file, isPdf ? 'application/pdf' : 'text/plain; charset=utf-8');
    }
  };

  const ils = Number(rate) || 0;

  return (
    <>
      <h1>הסכמי התקשרות</h1>
      <p className="muted">
        כל מסמך נשלח לכל המודלים שנבחרו במקביל, והתשובות מוצגות זו לצד זו, עם סימון המקומות שבהם הן חלוקות.
        כל קריאה נשמרת, כך שהסיכום בתחתית מחושב על כל מה שנוסה. שום דבר לא מתפרסם מכאן: שירות שנוצר נכנס
        כטיוטה לתור האישורים.
      </p>

      {catalogError && <p className="error">{catalogError}</p>}

      {catalog && (
        <ModelPicker
          catalog={catalog}
          selected={selected}
          onChange={setSelected}
          effort={effort}
          onEffort={setEffort}
          onRefresh={() => setRefreshNonce((n) => n + 1)}
        />
      )}

      <div className="actions">
        <label className={`btn${busy || usable.length === 0 ? ' disabled' : ''}`}>
          בחירת מסמכים
          <input
            type="file"
            multiple
            accept=".pdf,.txt,.md,.json,.csv,.html,.htm"
            style={{ display: 'none' }}
            disabled={!!busy || usable.length === 0}
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <span className="muted">
          {busy
            ? `שולח את ${busy}…`
            : usable.length === 0
              ? 'יש לבחור לפחות מודל זמין אחד'
              : `${usable.length} ${usable.length === 1 ? 'מודל' : 'מודלים'} · PDF עד ${catalog ? Math.round(catalog.max_bytes / 1e6) : 50} מגה־בייט, או קובץ טקסט`}
        </span>
      </div>

      <details>
        <summary className="muted">או הדבקת נוסח הסכם</summary>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          style={{ width: '100%', margin: '0.5rem 0', font: 'inherit', padding: '0.5rem' }}
          placeholder="נוסח ההסכם"
        />
        <button
          type="button"
          className="btn"
          disabled={!!busy || text.trim().length < 40 || usable.length === 0}
          onClick={() => void submit('טקסט שהודבק', text, 'text/plain; charset=utf-8')}
        >
          קריאה
        </button>
      </details>

      {error && <p className="error">{error}</p>}

      {openBatch && (
        <BatchView
          key={openBatch}
          batchId={openBatch}
          catalog={catalog}
          onSettled={refreshHistory}
          onClose={() => setOpenBatch(null)}
          onDeleted={() => {
            setOpenBatch(null);
            refreshHistory();
          }}
        />
      )}

      {stats && stats.models.length > 0 && (
        <Totals stats={stats.models} catalog={catalog} ils={ils} rate={rate} onRate={setRate} />
      )}

      {history && history.batches.length > 0 && (
        <History batches={history.batches} catalog={catalog} openBatch={openBatch} onOpen={setOpenBatch} />
      )}
    </>
  );
}

/* ------------------------------------------------------------ model picker */

function ModelPicker({
  catalog,
  selected,
  onChange,
  effort,
  onEffort,
  onRefresh,
}: {
  catalog: Catalog;
  selected: string[];
  onChange: (ids: string[]) => void;
  effort: Effort;
  onEffort: (e: Effort) => void;
  onRefresh: () => void;
}) {
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else if (selected.length < catalog.max_models_per_batch) onChange([...selected, id]);
  };

  return (
    <section className="models">
      <div className="models-head">
        <h2>מודלים</h2>
        <span className="muted">
          מחירים בדולר למיליון טוקנים (קלט / פלט), נכון ל־{catalog.prices_checked}. עד {catalog.max_models_per_batch}{' '}
          מודלים למסמך.
        </span>
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <label className="muted">
            עומק חשיבה{' '}
            <select value={effort} onChange={(e) => onEffort(e.target.value as Effort)}>
              {(['low', 'medium', 'high'] as const).map((e) => (
                <option key={e} value={e}>
                  {EFFORT_LABELS[e]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn small secondary" onClick={onRefresh}>
            בדיקת זמינות מחדש
          </button>
        </form>
      </div>

      <div className="providers">
        {catalog.providers.map((provider) => {
          const models = catalog.models.filter((m) => m.provider === provider.id);
          return (
            <div key={provider.id} className="provider">
              <h3>
                {provider.label}{' '}
                {!provider.configured ? (
                  <span className="pill bad">חסר {provider.key_names.join(' או ')}</span>
                ) : provider.reachable === false ? (
                  <span className="pill bad" title={provider.error}>
                    המפתח לא עובד
                  </span>
                ) : (
                  <span className="pill ok">מחובר</span>
                )}
              </h3>
              {provider.reachable === false && provider.error && <p className="error small">{provider.error}</p>}
              {models.map((m) => {
                const checked = selected.includes(m.id);
                const reason = !provider.configured
                  ? 'אין מפתח לספק'
                  : m.listed === false
                    ? 'המודל לא זמין בחשבון הזה'
                    : null;
                return (
                  <label key={m.id} className={`model${m.available ? '' : ' unavailable'}`} title={reason ?? m.note ?? m.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!m.available && !checked}
                      onChange={() => toggle(m.id)}
                    />
                    <span className="model-name">
                      {m.label} <span className="muted">· {TIER_LABELS[m.tier]}</span>
                    </span>
                    <span className="model-price nowrap">
                      ${m.prices.input} / ${m.prices.output}
                    </span>
                    {(reason || m.note) && <span className="model-note muted">{reason ?? m.note}</span>}
                    {m.efforts.length === 0 && <span className="model-note muted">ללא שליטה בעומק החשיבה</span>}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- a batch */

function BatchView({
  batchId,
  catalog,
  onSettled,
  onClose,
  onDeleted,
}: {
  batchId: string;
  catalog: Catalog | null;
  onSettled: () => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [applied, setApplied] = useState<Record<string, Record<string, string>>>({});

  const pending = runs?.some((r) => r.status === 'queued' || r.status === 'running') ?? true;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasPending = true;

    const load = async () => {
      try {
        const body = await api<{ runs: RunView[] }>(`/api/admin/agreements/batches/${batchId}`);
        if (cancelled) return;
        setRuns(body.runs);
        const stillPending = body.runs.some((r) => r.status === 'queued' || r.status === 'running');
        if (wasPending && !stillPending) onSettled();
        wasPending = stillPending;
        if (stillPending) timer = setTimeout(() => void load(), 3000);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, onSettled]);

  const label = (model: string) => catalog?.models.find((m) => m.id === model)?.label ?? model;
  const done = (runs ?? []).filter((r) => r.status === 'done' && r.extraction);
  const shown = tab && done.some((r) => r.id === tab) ? tab : (done[0]?.id ?? null);

  const remove = async () => {
    try {
      await api(`/api/admin/agreements/batches/${batchId}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!runs) return <p className="muted">טוען…</p>;
  const first = runs[0]!;

  return (
    <article className="report batch">
      <div className="batch-head">
        <h3>{first.filename}</h3>
        <span className="muted">
          {first.document_kind === 'pdf' ? 'PDF' : 'טקסט'} · {(first.document_bytes / 1e6).toFixed(1)} מגה־בייט ·{' '}
          {new Date(first.created_at).toLocaleString('he-IL')}
        </span>
        <span className="rowactions">
          <button type="button" className="btn small secondary" onClick={onClose}>
            סגירה
          </button>
          <button type="button" className="btn small secondary" disabled={pending} onClick={() => void remove()}>
            מחיקה מההיסטוריה
          </button>
        </span>
      </div>

      <Comparison runs={runs} label={label} />

      {done.length > 0 && <ServiceComparison runs={done} label={label} />}

      {done.length > 0 && (
        <>
          <h2>פירוט לפי מודל</h2>
          <div className="tabs" role="tablist">
            {done.map((run) => (
              <button
                key={run.id}
                type="button"
                role="tab"
                aria-selected={run.id === shown}
                className={run.id === shown ? 'active' : ''}
                onClick={() => setTab(run.id)}
              >
                {label(run.model)}
              </button>
            ))}
          </div>
          {done
            .filter((run) => run.id === shown)
            .map((run) => (
              <AgreementResult
                key={run.id}
                run={run}
                applied={applied[run.id] ?? {}}
                onApplied={(externalId, note) =>
                  setApplied((prev) => ({ ...prev, [run.id]: { ...(prev[run.id] ?? {}), [externalId]: note } }))
                }
              />
            ))}
        </>
      )}
    </article>
  );
}

/** A value for each run, and whether the finished runs disagree about it. */
function row(runs: RunView[], value: (run: RunView) => string | null) {
  const values = runs.map((r) => (r.status === 'done' ? value(r) : null));
  const distinct = new Set(values.filter((v, i) => runs[i]!.status === 'done').map((v) => v ?? '—'));
  return { values, differs: distinct.size > 1 };
}

function Comparison({ runs, label }: { runs: RunView[]; label: (model: string) => string }) {
  const matchSummary = (run: RunView) => {
    const counts: Record<string, number> = {};
    for (const m of run.matches ?? []) if (m) counts[m.decision] = (counts[m.decision] ?? 0) + 1;
    const parts = Object.entries(counts).map(([d, n]) => `${n} ${DECISION_LABELS[d] ?? d}`);
    return parts.length ? parts.join(', ') : '—';
  };

  const rows: { title: string; values: (string | null)[]; differs: boolean; numeric?: boolean }[] = [
    { title: 'הכרעה', ...row(runs, (r) => VERDICT_LABELS[r.extraction!.verdict.decision] ?? r.extraction!.verdict.decision) },
    { title: 'סוג ההתקשרות', ...row(runs, (r) => SUBJECT_LABELS[r.extraction!.verdict.subject] ?? r.extraction!.verdict.subject) },
    { title: 'תוקף פג', ...row(runs, (r) => (r.extraction!.verdict.expired ? 'כן' : 'לא')) },
    { title: 'הרשות', ...row(runs, (r) => r.extraction!.document.authority ?? null) },
    { title: 'המפעיל', ...row(runs, (r) => r.extraction!.document.provider ?? null) },
    { title: 'שירותים שחולצו', ...row(runs, (r) => String(r.extraction!.services.length)) },
    { title: 'מול המאגר', ...row(runs, matchSummary) },
    {
      title: 'ביטחון',
      values: runs.map((r) => (r.status === 'done' ? `${Math.round(r.extraction!.verdict.confidence * 100)}%` : null)),
      differs: false,
      numeric: true,
    },
    {
      title: 'אזהרות',
      values: runs.map((r) => (r.status === 'done' ? String(r.warnings.length) : null)),
      differs: false,
      numeric: true,
    },
  ];

  const money = (n: number | undefined) => (n === undefined ? '—' : `$${n.toFixed(4)}`);

  return (
    <div className="scroll">
      <table className="compare">
        <thead>
          <tr>
            <th />
            {runs.map((r) => (
              <th key={r.id}>
                {label(r.model)}
                {r.effort && <span className="muted"> · {EFFORT_LABELS[r.effort]}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>מצב</th>
            {runs.map((r) => (
              <td key={r.id}>
                <span className={`pill ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : 'empty'}`}>
                  {r.status === 'failed' && r.error ? (ERROR_LABELS[r.error.kind] ?? STATUS_LABELS.failed) : STATUS_LABELS[r.status]}
                </span>
                {r.error && <div className="error small">{r.error.message}</div>}
              </td>
            ))}
          </tr>
          {rows.map((line) => (
            <tr key={line.title}>
              <th>{line.title}</th>
              {line.values.map((v, i) => (
                <td key={runs[i]!.id} className={line.differs && runs[i]!.status === 'done' ? 'differs' : ''}>
                  {runs[i]!.status === 'done' ? (v ?? '—') : ''}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th>עלות</th>
            {runs.map((r) => (
              <td key={r.id} className="nowrap">
                {r.status === 'done' || r.status === 'failed' ? money(r.cost.total) : ''}
              </td>
            ))}
          </tr>
          <tr>
            <th>עלות למסמך באצווה</th>
            {runs.map((r) => (
              <td key={r.id} className="nowrap">
                {r.status === 'done' ? money(r.cost.marginal) : ''}
              </td>
            ))}
          </tr>
          <tr>
            <th>זמן</th>
            {runs.map((r) => (
              <td key={r.id} className="nowrap">
                {r.elapsed_ms != null ? `${(r.elapsed_ms / 1000).toFixed(1)} שנ׳` : ''}
              </td>
            ))}
          </tr>
          <tr>
            <th>טוקנים</th>
            {runs.map((r) => (
              <td key={r.id} className="muted small">
                {r.status === 'done' || r.status === 'failed' ? tokens(r) : ''}
              </td>
            ))}
          </tr>
          <tr>
            <th>ניסיונות</th>
            {runs.map((r) => (
              <td key={r.id}>{r.attempts || ''}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function tokens(run: RunView): string {
  const u = run.usage;
  const n = (v: number | undefined | null) => (v ?? 0).toLocaleString('he-IL');
  const parts = [`${n(u.input)} קלט`];
  if (u.cache_read) parts.push(`${n(u.cache_read)} מהמטמון`);
  if (u.cache_write) parts.push(`${n(u.cache_write)} נכתבו למטמון`);
  parts.push(`${n(u.output)} פלט`);
  if (u.reasoning) parts.push(`מתוכם ${n(u.reasoning)} חשיבה`);
  return parts.join(' · ');
}

/**
 * The services each model extracted, lined up.
 *
 * Models do not return services in the same order or under the same names, so
 * they are grouped by how much their names share, not by position. A model
 * that extracted nothing for a group shows "לא חולץ" there, which is itself one
 * of the most useful things this table can show.
 */
function ServiceComparison({ runs, label }: { runs: RunView[]; label: (model: string) => string }) {
  const groups = useMemo(() => alignServices(runs), [runs]);
  if (groups.length === 0) return null;

  const fields: { title: string; value: (s: ServiceView, run: RunView, index: number) => string }[] = [
    { title: 'שם', value: (s) => s.name },
    { title: 'גוף מפעיל', value: (s) => s.organization?.name ?? '—' },
    { title: 'מספר תאגיד', value: (s) => s.organization?.id ?? '—' },
    {
      title: 'מקום',
      value: (s) =>
        s.national_service
          ? 'ארצי'
          : (s.branches ?? [])
              .map((b) => [b.address, b.city].filter(Boolean).join(', '))
              .filter(Boolean)
              .join(' | ') || '—',
    },
    { title: 'טלפונים', value: (s) => (s.phone_numbers ?? []).join(', ') || '—' },
    {
      title: 'תשלום',
      value: (s) => (s.payment_required === true ? 'בתשלום' : s.payment_required === false ? 'ללא תשלום' : 'לא צוין'),
    },
    { title: 'מה השירות נותן', value: (s) => shortTags(s.responses) },
    { title: 'למי', value: (s) => shortTags(s.situations) },
    {
      title: 'מול המאגר',
      value: (_s, run, index) => {
        const m = run.matches?.[index];
        return m ? `${DECISION_LABELS[m.decision] ?? m.decision}${m.best ? ` (${m.best.score.toFixed(2)})` : ''}` : '—';
      },
    },
  ];

  return (
    <>
      <h2>השירותים שחולצו</h2>
      {groups.map((group, g) => (
        <div key={g} className="scroll">
          <table className="compare">
            <thead>
              <tr>
                <th>שירות {g + 1}</th>
                {runs.map((r) => (
                  <th key={r.id}>{label(r.model)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => {
                const values = runs.map((run, i) => {
                  const hit = group[i];
                  return hit ? field.value(hit.service, run, hit.index) : null;
                });
                const present = values.filter((v): v is string => v !== null);
                const differs = new Set(present).size > 1 || present.length < runs.length;
                return (
                  <tr key={field.title}>
                    <th>{field.title}</th>
                    {values.map((v, i) => (
                      <td key={runs[i]!.id} className={v === null ? 'missing' : differs ? 'differs' : ''}>
                        {v ?? (field.title === 'שם' ? 'לא חולץ' : '')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

function shortTags(ids: string[] | null | undefined): string {
  if (!ids?.length) return '—';
  return ids.map((id) => id.split(':').slice(-1)[0]).join(', ');
}

type Aligned = ({ service: ServiceView; index: number } | undefined)[];

function alignServices(runs: RunView[]): Aligned[] {
  const groups: { name: string; members: Aligned }[] = [];
  runs.forEach((run, r) => {
    (run.extraction?.services ?? []).forEach((service, index) => {
      let best = -1;
      let bestScore = 0;
      groups.forEach((group, g) => {
        if (group.members[r]) return;
        const score = similarity(group.name, service.name);
        if (score > bestScore) {
          best = g;
          bestScore = score;
        }
      });
      if (best >= 0 && bestScore >= 0.34) {
        groups[best]!.members[r] = { service, index };
      } else {
        const members: Aligned = runs.map(() => undefined);
        members[r] = { service, index };
        groups.push({ name: service.name, members });
      }
    });
  });
  return groups.map((g) => g.members);
}

function words(value: string): Set<string> {
  return new Set(
    value
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[והבלכמש](?=\p{L}{3,})/u, ''))
      .filter((w) => w.length > 1),
  );
}

function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/* ------------------------------------------------------------------ totals */

function Totals({
  stats,
  catalog,
  ils,
  rate,
  onRate,
}: {
  stats: ModelStats[];
  catalog: Catalog | null;
  ils: number;
  rate: string;
  onRate: (value: string) => void;
}) {
  const label = (model: string) => catalog?.models.find((m) => m.id === model)?.label ?? model;
  const sorted = [...stats].sort((a, b) => (a.avg_marginal ?? Infinity) - (b.avg_marginal ?? Infinity));

  return (
    <>
      <h2>סיכום לפי מודל</h2>
      <p className="muted">
        על כל המסמכים שנקראו עד כה. העלות למסמך היא העלות באצווה, כשהפרומפט כבר שמור במטמון. ״הסכמה״ היא כמה פעמים
        ההכרעה של המודל הייתה זהה לזו של רוב המודלים האחרים שקראו את אותו מסמך. הסכמה אינה דיוק, אבל מודל שחורג
        מהאחרים שוב ושוב שווה בדיקה.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>מודל</th>
              <th>קריאות</th>
              <th>נכשלו</th>
              <th>הסכמה</th>
              <th>זמן ממוצע</th>
              <th>למסמך</th>
              <th>ל־1,000 מסמכים</th>
              <th>בשקלים</th>
              <th>שולם</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.model}>
                <td>{label(s.model)}</td>
                <td>{s.runs}</td>
                <td className={s.failed ? 'error' : ''}>{s.failed}</td>
                <td>
                  {s.agreement.compared
                    ? `${Math.round((s.agreement.agreed / s.agreement.compared) * 100)}% (${s.agreement.agreed}/${s.agreement.compared})`
                    : '—'}
                </td>
                <td className="nowrap">{s.avg_ms != null ? `${(s.avg_ms / 1000).toFixed(1)} שנ׳` : '—'}</td>
                <td className="nowrap">{s.avg_marginal != null ? `$${s.avg_marginal.toFixed(4)}` : '—'}</td>
                <td className="nowrap">{s.avg_marginal != null ? `$${(s.avg_marginal * 1000).toFixed(0)}` : '—'}</td>
                <td className="nowrap">{s.avg_marginal != null ? `₪${(s.avg_marginal * 1000 * ils).toFixed(0)}` : '—'}</td>
                <td className="nowrap">${(s.spent ?? 0).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label className="muted">
          שער דולר <input type="number" step="0.01" value={rate} onChange={(e) => onRate(e.target.value)} />
        </label>
        <span className="muted">התחזית נכונה רק למסמכים דומים לאלה שנקראו. סריקה ארוכה עולה פי כמה מהסכם קצר בטקסט.</span>
      </form>
    </>
  );
}

function History({
  batches,
  catalog,
  openBatch,
  onOpen,
}: {
  batches: BatchSummary[];
  catalog: Catalog | null;
  openBatch: string | null;
  onOpen: (id: string) => void;
}) {
  const label = (model: string) => catalog?.models.find((m) => m.id === model)?.label ?? model;
  return (
    <>
      <h2>מסמכים שנקראו</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>מסמך</th>
              <th>מתי</th>
              <th>מודלים</th>
              <th>עלות</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.batch_id} className={b.batch_id === openBatch ? 'current' : ''}>
                <td>{b.filename}</td>
                <td className="nowrap muted">{new Date(b.created_at).toLocaleString('he-IL')}</td>
                <td>
                  {b.runs.map((r) => (
                    <span
                      key={r.id}
                      className={`pill ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : 'empty'}`}
                      title={r.error ?? undefined}
                    >
                      {label(r.model)}:{' '}
                      {r.status === 'done'
                        ? (VERDICT_LABELS[r.decision ?? ''] ?? r.decision ?? '—')
                        : STATUS_LABELS[r.status]}
                    </span>
                  ))}
                </td>
                <td className="nowrap">${b.runs.reduce((sum, r) => sum + (r.cost ?? 0), 0).toFixed(3)}</td>
                <td>
                  <button type="button" className="btn small secondary" onClick={() => onOpen(b.batch_id)}>
                    פתיחה
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ----------------------------------------------------- one model's reading */

function AgreementResult({
  run,
  applied,
  onApplied,
}: {
  run: RunView;
  applied: Record<string, string>;
  onApplied: (id: string, note: string) => void;
}) {
  const extraction = run.extraction!;
  const verdict = extraction.verdict;
  // Green for a document that produced something, amber for one that nearly
  // did, grey-red for one that is not a service at all — which is the ordinary
  // outcome and not an error.
  const pill = verdict.decision === 'relevant' ? 'ok' : verdict.decision === 'partial' ? 'empty' : 'bad';

  return (
    <div className="detail">
      <h3>
        {extraction.document.title || run.filename}{' '}
        <span className={`pill ${pill}`}>{VERDICT_LABELS[verdict.decision] ?? verdict.decision}</span>
      </h3>
      <p className="muted">
        {run.served_model ?? run.model} · {SUBJECT_LABELS[verdict.subject] ?? verdict.subject}
        {extraction.document.authority ? ` · ${extraction.document.authority}` : ''}
        {verdict.expired ? ' · תוקף ההסכם פג' : ''} · ${(run.cost.total ?? 0).toFixed(4)} ·{' '}
        {((run.elapsed_ms ?? 0) / 1000).toFixed(1)} שניות
      </p>
      <p>{verdict.reason}</p>

      {run.warnings.map((w) => (
        <p key={w} className="banner">
          {w}
        </p>
      ))}

      {extraction.services.map((service, i) => (
        <ExtractedService
          key={service.external_id}
          service={service}
          match={run.matches?.[i] ?? null}
          document={extraction.document}
          model={run.served_model ?? run.model}
          applied={applied[service.external_id]}
          onApplied={(note) => onApplied(service.external_id, note)}
        />
      ))}

      {(extraction.unmapped ?? []).length > 0 && (
        <>
          <strong>לא ניתן היה לחלץ</strong>
          <ul className="cardlist">
            {extraction.unmapped!.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </>
      )}
      {(extraction.questions ?? []).length > 0 && (
        <>
          <strong>לבדיקה אנושית</strong>
          <ul className="cardlist">
            {extraction.questions!.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ExtractedService({
  service,
  match,
  document,
  model,
  applied,
  onApplied,
}: {
  service: ServiceView;
  match: MatchView | null;
  document: DocumentView;
  model: string;
  applied?: string | undefined;
  onApplied: (note: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (body: Record<string, unknown>, note: (result: Record<string, string>) => string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Record<string, string>>('/api/admin/agreements/apply', {
        method: 'POST',
        body: JSON.stringify({ document, ...body }),
      });
      onApplied(note(result));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const where = service.national_service
    ? 'ארצי'
    : (service.branches ?? [])
        .map((b) => b.city ?? b.address)
        .filter(Boolean)
        .join(', ') || 'ללא מקום';

  return (
    <div className="service">
      <p>
        <strong style={{ display: 'inline' }}>{service.name}</strong>{' '}
        {match && (
          <span className={`pill ${match.decision === 'new' ? 'ok' : match.decision === 'link' ? 'empty' : 'bad'}`}>
            {DECISION_LABELS[match.decision] ?? match.decision}
          </span>
        )}
      </p>
      <p className="muted">
        {service.organization?.name ?? 'ללא גוף מפעיל'}
        {service.organization?.id ? ` · ${service.organization.id}` : ''} · {where} ·{' '}
        {(service.responses ?? []).join(', ') || 'ללא תגיות'}
      </p>
      {service.description && <p>{service.description}</p>}

      {(service.source_quotes ?? []).length > 0 && (
        <details>
          <summary className="muted">ציטוטים מהמסמך</summary>
          <ul className="cardlist">
            {service.source_quotes!.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </details>
      )}

      {match && match.decision !== 'new' && (
        <>
          <p className="muted">{match.rationale.join(' ')}</p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>ציון</th>
                  <th>שירות קיים</th>
                  <th>מפעיל</th>
                  <th>מקום</th>
                  <th>נימוק</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {match.candidates.map((c) => (
                  <tr key={c.service_id}>
                    <td className="nowrap">{c.score.toFixed(2)}</td>
                    <td>
                      <a href={`/s/${c.card_id}`} target="_blank" rel="noreferrer">
                        {c.service_name}
                      </a>
                    </td>
                    <td>{c.organization_name}</td>
                    <td>{c.national_service ? 'ארצי' : (c.city ?? '—')}</td>
                    <td className="muted">{c.reasons.join(' ')}</td>
                    <td>
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy || !!applied}
                        onClick={() =>
                          void apply(
                            {
                              action: 'link',
                              service_id: c.service_id,
                              confidence: c.score,
                              evidence: {
                                components: c.components,
                                reasons: c.reasons,
                                rationale: match.rationale,
                                read_by: model,
                                candidate: {
                                  name: service.name,
                                  organization: service.organization?.name ?? null,
                                },
                                source_quotes: service.source_quotes ?? [],
                              },
                            },
                            () => `קושר אל ${c.service_name}`,
                          )
                        }
                      >
                        קישור ההסכם
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="rowactions">
        <button
          type="button"
          className="btn small secondary"
          disabled={busy || !!applied}
          onClick={() => void apply({ action: 'create', service }, (r) => `נוצרה טיוטה ${r['service_id']}`)}
        >
          {match?.decision === 'new' ? 'יצירת שירות חדש' : 'יצירה כשירות נפרד בכל זאת'}
        </button>
        {applied && <span className="pill ok">{applied}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
