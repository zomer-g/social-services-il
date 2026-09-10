import { useState } from 'react';
import { api, useLoad } from './App';

/**
 * Reading agreements, one at a time, with the bill on the screen.
 *
 * This screen exists to answer the question that decides whether to run the
 * pipeline over an archive at all: what does one document cost, and does the
 * reading get the three cases right — a service we already have, a service we
 * do not, and a contract for furniture.
 *
 * So the cost is not a footnote here. It is beside the result, per document and
 * projected, and it is projected from the *marginal* cost rather than the total:
 * the prompt carries the whole taxonomy and is written to the model's cache
 * once per run, so the first document is never representative of the batch and
 * multiplying it by ten thousand would overstate the bill several times over.
 *
 * Nothing here reaches the public site. A service created from this screen is a
 * draft in the review queue, because what is on it was read out of a PDF by a
 * model, and the last step before publication belongs to a person.
 */

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
  organization?: { name?: string; id?: string | null } | null;
  branches?: { city?: string | null; address?: string | null }[] | null;
  responses?: string[] | null;
  national_service?: boolean;
  source_quotes?: string[] | null;
  [key: string]: unknown;
}

interface DocumentView {
  external_id: string;
  title?: string | null;
  kind?: string | null;
  authority?: string | null;
  ends_on?: string | null;
}

interface Analysis {
  filename: string;
  model: string;
  elapsed_ms: number;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  cost: { total: number; marginal: number };
  extraction: {
    document: DocumentView;
    verdict: { decision: string; reason: string; subject: string; expired: boolean; confidence: number };
    services: ServiceView[];
    unmapped?: string[];
    questions?: string[];
  };
  warnings: string[];
  matches: (MatchView | null)[];
  /** What the operator has already done with each extracted service. */
  applied?: Record<string, string>;
}

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

export function Agreements() {
  const { data: status } = useLoad<{ available: boolean; model: string; max_bytes: number }>(
    '/api/admin/agreements/status',
  );
  const [runs, setRuns] = useState<Analysis[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [rate, setRate] = useState('3.7');

  const analyse = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const result = await api<Analysis>('/api/admin/agreements/analyze', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setRuns((prev) => [result, ...prev]);
    } catch (err) {
      setError(`${label}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    // One at a time and in order: the first document pays for the prompt cache
    // and every one after it reads from it, which is the shape the projection
    // below assumes.
    for (const file of Array.from(files)) {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        await analyse({ filename: file.name, data_base64: await toBase64(file) }, file.name);
      } else {
        await analyse({ filename: file.name, text: await file.text() }, file.name);
      }
    }
  };

  const totals = runs.reduce(
    (acc, r) => ({
      documents: acc.documents + 1,
      input: acc.input + r.usage.input + r.usage.cache_read + r.usage.cache_write,
      output: acc.output + r.usage.output,
      total: acc.total + r.cost.total,
      marginal: acc.marginal + r.cost.marginal,
      seconds: acc.seconds + r.elapsed_ms / 1000,
    }),
    { documents: 0, input: 0, output: 0, total: 0, marginal: 0, seconds: 0 },
  );
  const perDocument = totals.documents ? totals.marginal / totals.documents : 0;
  const perSeconds = totals.documents ? totals.seconds / totals.documents : 0;
  const ils = Number(rate) || 0;

  return (
    <>
      <h1>הסכמי התקשרות</h1>
      <p className="muted">
        כל מסמך נקרא פעם אחת ומוכרע: שירות לציבור או לא. שירות שחולץ נבדק מול המאגר — קיים כאן, חדש,
        או דורש הכרעה. שום דבר לא מתפרסם מכאן: שירות שנוצר נכנס כטיוטה לתור האישורים.
      </p>

      {status && !status.available && (
        <p className="banner">
          לא הוגדר <code>ANTHROPIC_API_KEY</code> בשרת, ולכן שלב הקריאה אינו זמין.
        </p>
      )}

      <div className="actions">
        <label className="btn">
          בחירת מסמכים
          <input
            type="file"
            multiple
            accept=".pdf,.txt,.md,.json,.csv,.html,.htm"
            style={{ display: 'none' }}
            disabled={!!busy}
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <span className="muted">
          {busy
            ? `קורא את ${busy}…`
            : `PDF עד ${status ? Math.round(status.max_bytes / 1e6) : 20} מגה־בייט, או קובץ טקסט`}
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
          disabled={!!busy || text.trim().length < 40}
          onClick={() => void analyse({ filename: 'טקסט שהודבק', text }, 'הדבקה')}
        >
          קריאה
        </button>
      </details>

      {error && <p className="error">{error}</p>}

      {totals.documents > 0 && (
        <>
          <h2>עלות</h2>
          <div className="stats">
            <div className="stat">
              <span className="value">{totals.documents}</span>
              <span className="label">מסמכים נקראו</span>
            </div>
            <div className="stat">
              <span className="value">${totals.total.toFixed(3)}</span>
              <span className="label">שולם עד כה</span>
            </div>
            <div className="stat">
              <span className="value">${perDocument.toFixed(4)}</span>
              <span className="label">למסמך באצווה</span>
            </div>
            <div className="stat">
              <span className="value">{perSeconds.toFixed(1)} שנ׳</span>
              <span className="label">זמן ממוצע למסמך</span>
            </div>
          </div>
          <p className="muted">
            {totals.input.toLocaleString('he-IL')} טוקנים נכנסים, {totals.output.toLocaleString('he-IL')} יוצאים.
            העלות למסמך מחושבת לפי מסמך שהפרומפט כבר שמור עבורו במטמון — כלומר מהמסמך השני והלאה.
            המסמך הראשון יקר יותר ואינו מייצג אצווה.
          </p>
          <table>
            <thead>
              <tr>
                <th>היקף</th>
                <th>עלות משוערת</th>
                <th>בשקלים</th>
                <th>זמן, מסמך אחרי מסמך</th>
              </tr>
            </thead>
            <tbody>
              {[100, 1000, 10000].map((n) => (
                <tr key={n}>
                  <td>{n.toLocaleString('he-IL')} הסכמים</td>
                  <td>${(perDocument * n).toFixed(2)}</td>
                  <td>₪{(perDocument * n * ils).toFixed(2)}</td>
                  <td>{formatDuration(perSeconds * n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="inline" onSubmit={(e) => e.preventDefault()}>
            <label className="muted">
              שער דולר{' '}
              <input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
            </label>
            <span className="muted">
              הזמן הוא מסמך אחרי מסמך; הסקריפט קורא כמה במקביל, ומחלק אותו בהתאם.
            </span>
          </form>
        </>
      )}

      {runs.map((run, i) => (
        <AgreementResult
          key={`${run.filename}-${i}`}
          run={run}
          onApplied={(externalId, note) =>
            setRuns((prev) =>
              prev.map((r, j) =>
                j === i ? { ...r, applied: { ...(r.applied ?? {}), [externalId]: note } } : r,
              ),
            )
          }
        />
      ))}
    </>
  );
}

function AgreementResult({ run, onApplied }: { run: Analysis; onApplied: (id: string, note: string) => void }) {
  const verdict = run.extraction.verdict;
  // Green for a document that produced something, amber for one that nearly
  // did, grey-red for one that is not a service at all — which is the ordinary
  // outcome and not an error.
  const pill = verdict.decision === 'relevant' ? 'ok' : verdict.decision === 'partial' ? 'empty' : 'bad';

  return (
    <article className="report">
      <h3>
        {run.extraction.document.title || run.filename}{' '}
        <span className={`pill ${pill}`}>{VERDICT_LABELS[verdict.decision] ?? verdict.decision}</span>
      </h3>
      <p className="muted">
        {run.filename} · {SUBJECT_LABELS[verdict.subject] ?? verdict.subject}
        {run.extraction.document.authority ? ` · ${run.extraction.document.authority}` : ''}
        {verdict.expired ? ' · תוקף ההסכם פג' : ''} · ${run.cost.total.toFixed(4)} ·{' '}
        {(run.elapsed_ms / 1000).toFixed(1)} שניות
      </p>
      <p>{verdict.reason}</p>

      {run.warnings.map((w) => (
        <p key={w} className="banner">
          {w}
        </p>
      ))}

      {run.extraction.services.map((service, i) => (
        <ExtractedService
          key={service.external_id}
          service={service}
          match={run.matches[i] ?? null}
          document={run.extraction.document}
          applied={run.applied?.[service.external_id]}
          onApplied={(note) => onApplied(service.external_id, note)}
        />
      ))}

      {(run.extraction.unmapped ?? []).length > 0 && (
        <>
          <strong>לא ניתן היה לחלץ</strong>
          <ul className="cardlist">
            {run.extraction.unmapped!.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </>
      )}
      {(run.extraction.questions ?? []).length > 0 && (
        <>
          <strong>לבדיקה אנושית</strong>
          <ul className="cardlist">
            {run.extraction.questions!.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

function ExtractedService({
  service,
  match,
  document,
  applied,
  onApplied,
}: {
  service: ServiceView;
  match: MatchView | null;
  document: DocumentView;
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
    <div className="detail">
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

/** Chunked: a megabyte-long argument list overflows the call stack. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} שניות`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} דקות`;
  return `${(seconds / 3600).toFixed(1)} שעות`;
}
