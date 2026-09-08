import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Card } from './api.js';
import { ActionCard, useSaved } from './components.js';
import { stringsFor, type Lang } from './i18n.js';

/**
 * Smart search.
 *
 * The ordinary box needs the right words. This one takes a sentence and works
 * out which categories it means before searching — the step a person is
 * otherwise expected to do in their head.
 *
 * It runs on the same tools the MCP server exposes, called from the server. Two
 * consequences shape this page. The answer is a short paragraph and never a list,
 * because the services themselves appear underneath as ordinary cards, with the
 * same dial button as everywhere else. And what the search actually understood
 * is shown as chips, because a system that quietly decides what you meant and
 * shows you results is impossible to correct when it is wrong.
 */

interface SmartResponse {
  answer: string;
  understood: { responses: { id: string; name: string }[]; situations: { id: string; name: string }[]; city?: string };
  cards: Card[];
  tools_used: string[];
  sources?: string[];
  unavailable?: { server: string; error: string }[];
}

export interface SearchModes {
  /** A model key is configured, so either AI path can run at all. */
  smart: boolean;
  /**
   * More than one MCP server is registered, so searching all of them is
   * genuinely different from searching this corpus. With a single source the
   * two buttons would do the same thing, and two buttons that do the same
   * thing is worse than one.
   */
  deep: boolean;
  sources: { slug: string; name: string; description: string | null }[];
}

export function useSearchModes(): SearchModes {
  const [modes, setModes] = useState<SearchModes>({ smart: false, deep: false, sources: [] });
  useEffect(() => {
    fetch('/api/v1/sources')
      .then((r) => r.json())
      .then((s: { available: boolean; deep_search_useful: boolean; sources: SearchModes['sources'] }) =>
        setModes({ smart: s.available, deep: s.available && s.deep_search_useful, sources: s.sources }),
      )
      .catch(() => setModes({ smart: false, deep: false, sources: [] }));
  }, []);
  return modes;
}

export function SmartPage({ lang, deep = false }: { lang: Lang; deep?: boolean }) {
  const t = stringsFor(lang);
  const [params] = useSearchParams();
  const [result, setResult] = useState<SmartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, toggleSave] = useSaved();

  const q = params.get('q') ?? '';
  const lat = params.get('lat');
  const lon = params.get('lon');

  useEffect(() => {
    if (!q) return;
    setLoading(true);
    setError(null);
    fetch(deep ? '/api/v1/deep-search' : '/api/v1/smart-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        q,
        lang,
        ...(lat && lon ? { lat: Number(lat), lon: Number(lon) } : {}),
      }),
    })
      .then(async (r) => {
        const body = (await r.json()) as SmartResponse & { message?: string };
        if (!r.ok) throw new Error(body.message ?? t.smartError);
        return body;
      })
      .then(setResult)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [q, lang, lat, lon, deep, t.smartError]);

  const backToPlain = `/search?q=${encodeURIComponent(q)}&lang=${lang}${lat && lon ? `&lat=${lat}&lon=${lon}` : ''}`;

  return (
    <>
      <h1>
        {deep ? t.deepAction : t.smartAction}: <span className="quoted">{q}</span>
      </h1>

      {/* A live region, so a screen reader is told the answer arrived rather
          than leaving the reader to go looking for it. */}
      <div aria-live="polite" aria-busy={loading}>
        {loading && (
          <p className="empty">
            <span className="spinner" aria-hidden="true" /> {t.smartThinking}
          </p>
        )}

        {error && (
          <div className="notice">
            <p>{error}</p>
            <Link className="btn secondary" to={backToPlain}>
              {t.smartBackToPlain}
            </Link>
          </div>
        )}

        {result && (
          <>
            {result.answer && <p className="lead">{result.answer}</p>}

            {(result.understood.responses.length > 0 || result.understood.situations.length > 0) && (
              <section aria-labelledby="understood-heading">
                <h2 id="understood-heading" className="facetlabel">
                  {t.smartUnderstood}
                </h2>
                <div className="chips">
                  {[...result.understood.responses, ...result.understood.situations].map((node) => (
                    // Each is a link back into the ordinary search for that
                    // category, so a wrong reading is one tap from correcting.
                    <Link
                      key={node.id}
                      className="chip"
                      to={`/search?${result.understood.responses.some((r) => r.id === node.id) ? 'response' : 'situation'}=${encodeURIComponent(node.id)}&lang=${lang}`}
                    >
                      {node.name}
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {result && result.cards.length > 0 && (
        <>
          <h2 className="visually-hidden">{t.results}</h2>
          <ul className="cards">
            {result.cards.map((card) => (
              <ActionCard
                key={card.card_id}
                card={card}
                lang={lang}
                saved={saved.includes(card.card_id)}
                onToggleSave={toggleSave}
              />
            ))}
          </ul>
        </>
      )}

      {result && result.cards.length === 0 && !loading && (
        <div className="empty">
          <p>{t.noResultsBody}</p>
          <Link className="btn secondary" to={backToPlain}>
            {t.smartBackToPlain}
          </Link>
        </div>
      )}

      {result && (
        <p className="source">
          {/* Which sources actually answered. An answer assembled from two
              sources when three were asked is a different answer, and hiding
              that would be the wrong kind of tidy. */}
          {deep && result.sources && result.sources.length > 0 && (
            <>
              {t.deepSources}: {result.sources.join(', ')}
              {result.unavailable && result.unavailable.length > 0 && (
                <> · {t.deepUnavailable(result.unavailable.map((u) => u.server).join(', '))}</>
              )}
              <br />
            </>
          )}
          <Link to={backToPlain}>{t.smartBackToPlain}</Link>
        </p>
      )}
    </>
  );
}
