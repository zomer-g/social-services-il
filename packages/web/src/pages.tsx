import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { autocomplete, getCard, reportError, search, type Card, type CardDetail, type Suggestion } from './api.js';
import { ActionCard, UrgentBar, useGeolocation, useSaved } from './components.js';
import { stringsFor, type Lang } from './i18n.js';

const PAGE_SIZE = 20;

/**
 * The six needs on the home page.
 *
 * These are taxonomy ids, not categories invented for the UI: tapping one is
 * exactly the same as filtering by that node, so the home page cannot drift out
 * of step with what the corpus actually contains.
 */
const NEEDS: { key: 'needFood' | 'needMoney' | 'needHousing' | 'needHealth' | 'needMental' | 'needViolence'; glyph: string; response?: string; situation?: string }[] = [
  { key: 'needFood', glyph: '🍲', response: 'human_services:food' },
  { key: 'needMoney', glyph: '🪙', response: 'human_services:money' },
  { key: 'needHousing', glyph: '🏠', response: 'human_services:housing' },
  { key: 'needHealth', glyph: '🩺', response: 'human_services:health' },
  { key: 'needMental', glyph: '💬', situation: 'human_situations:mental_health' },
  { key: 'needViolence', glyph: '🛡️', situation: 'human_situations:survivors:violence_survivors' },
];

export function HomePage({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const geo = useGeolocation();

  // Suggestions are advisory: typing and pressing enter always works, so a slow
  // or failed lookup never blocks the search.
  useEffect(() => {
    if (term.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      autocomplete(term.trim(), lang, controller.signal)
        .then((r) => setSuggestions(r.taxonomy.slice(0, 6)))
        .catch(() => setSuggestions([]));
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [term, lang]);

  useEffect(() => {
    if (geo.status === 'ready') {
      navigate(`/search?lat=${geo.lat}&lon=${geo.lon}&lang=${lang}`);
    }
  }, [geo.status, geo.lat, geo.lon, lang, navigate]);

  const go = (params: Record<string, string>) => {
    const search = new URLSearchParams({ ...params, lang });
    navigate(`/search?${search}`);
  };

  return (
    <>
      <section className="hero">
        <h1>{t.askPrompt}</h1>
        <p>{t.tagline}</p>

        <form
          className="searchform"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (term.trim()) go({ q: term.trim() });
          }}
        >
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchPlaceholder}
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit" className="btn">
            {t.searchAction}
          </button>
        </form>

        {suggestions.length > 0 && (
          <ul className="suggestions">
            {suggestions.map((s) => (
              <li key={`${s.axis}:${s.id}`}>
                <button
                  type="button"
                  onClick={() => go(s.axis === 'response' ? { response: s.id } : { situation: s.id })}
                >
                  <span>{s.name}</span>
                  <span className="count">{s.card_count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="btn secondary block"
          onClick={geo.request}
          disabled={geo.status === 'working'}
        >
          {geo.status === 'working' ? t.nearMeWorking : `📍 ${t.nearMe}`}
        </button>
        {geo.status === 'denied' && <p className="notice">{t.locationDenied}</p>}
      </section>

      <UrgentBar lang={lang} />

      <section aria-labelledby="needs-heading">
        <h2 id="needs-heading">{t.commonNeeds}</h2>
        <div className="needs">
          {NEEDS.map((n) => (
            <button
              key={n.key}
              type="button"
              className="need"
              onClick={() => go(n.response ? { response: n.response } : { situation: n.situation! })}
            >
              <span className="glyph" aria-hidden="true">
                {n.glyph}
              </span>
              <span>{t[n.key]}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

export function ResultsPage({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<{ responses: { id: string; name: string | null; count: number }[]; situations: { id: string; name: string | null; count: number }[] }>({ responses: [], situations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, toggleSave] = useSaved();
  const offsetRef = useRef(0);

  const q = params.get('q') ?? undefined;
  const responses = params.getAll('response');
  const situations = params.getAll('situation');
  const city = params.get('city') ?? undefined;
  const lat = params.get('lat');
  const lon = params.get('lon');

  const key = params.toString();

  useEffect(() => {
    const controller = new AbortController();
    offsetRef.current = 0;
    setLoading(true);
    setError(null);

    search(
      {
        q,
        response: responses,
        situation: situations,
        city,
        lat: lat ? Number(lat) : undefined,
        lon: lon ? Number(lon) : undefined,
        limit: PAGE_SIZE,
        lang,
      },
      controller.signal,
    )
      .then((r) => {
        setCards(r.cards);
        setTotal(r.total);
        setFacets({ responses: r.facets.responses, situations: r.facets.situations });
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
    // `key` captures every filter in the URL, which is the whole query state.
  }, [key, lang]);

  const loadMore = () => {
    offsetRef.current += PAGE_SIZE;
    setLoading(true);
    search({
      q,
      response: responses,
      situation: situations,
      city,
      lat: lat ? Number(lat) : undefined,
      lon: lon ? Number(lon) : undefined,
      limit: PAGE_SIZE,
      offset: offsetRef.current,
      lang,
    })
      .then((r) => setCards((current) => [...current, ...r.cards]))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const toggleFacet = (name: 'response' | 'situation', id: string) => {
    const next = new URLSearchParams(params);
    const existing = next.getAll(name);
    next.delete(name);
    for (const value of existing.includes(id) ? existing.filter((v) => v !== id) : [...existing, id]) {
      next.append(name, value);
    }
    setParams(next);
  };

  const active = new Set([...responses, ...situations]);
  // Only the facets that would actually change the result set are worth showing;
  // a filter that keeps everything is noise on a small screen.
  const usefulFacets = [
    ...facets.responses.map((f) => ({ ...f, axis: 'response' as const })),
    ...facets.situations.map((f) => ({ ...f, axis: 'situation' as const })),
  ]
    .filter((f) => f.name && (active.has(f.id) || (f.count > 0 && f.count < total)))
    .slice(0, 10);

  return (
    <>
      <h1 className="visually-hidden">{t.resultsHeading}</h1>
      <div className="resultbar">
        <strong>{t.resultsCount(total)}</strong>
        {city && <span>· {city}</span>}
        {lat && <span>· {t.nearMe}</span>}
        {active.size > 0 && (
          <button
            type="button"
            className="chip"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('response');
              next.delete('situation');
              setParams(next);
            }}
          >
            {t.clearFilters}
          </button>
        )}
      </div>

      {(['response', 'situation'] as const).map((axis) => {
        const group = usefulFacets.filter((f) => f.axis === axis);
        if (group.length === 0) return null;
        const label = axis === 'response' ? t.whatKind : t.whoFor;
        return (
          <div key={axis} className="facetgroup">
            <span className="facetlabel" id={`facet-${axis}`}>
              {label}
            </span>
            <div className="chips" role="group" aria-labelledby={`facet-${axis}`}>
              {group.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="chip"
                  aria-pressed={active.has(f.id)}
                  onClick={() => toggleFacet(f.axis, f.id)}
                >
                  {f.name}
                  <span className="count">{f.count}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {error && <p className="notice">{error}</p>}

      {!loading && cards.length === 0 && !error && (
        <div className="empty">
          <h2>{t.noResults}</h2>
          <p>{t.noResultsBody}</p>
          <Link className="btn secondary" to={`/?lang=${lang}`}>
            {t.back}
          </Link>
        </div>
      )}

      <ul className="cards">
        {cards.map((card) => (
          <ActionCard
            key={card.card_id}
            card={card}
            lang={lang}
            saved={saved.includes(card.card_id)}
            onToggleSave={toggleSave}
          />
        ))}
      </ul>

      {loading && (
        <p className="empty">
          <span className="spinner" aria-hidden="true" /> {t.loading}
        </p>
      )}

      {!loading && cards.length < total && (
        <button type="button" className="btn secondary block" onClick={loadMore} style={{ marginTop: '1rem' }}>
          {t.loadMore}
        </button>
      )}
    </>
  );
}

export function ServicePage({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);
  const { cardId } = useParams();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, toggleSave] = useSaved();
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (!cardId) return;
    getCard(cardId, lang)
      .then(setCard)
      .catch((err: Error) => setError(err.message));
  }, [cardId, lang]);

  if (error) return <p className="notice">{error}</p>;
  if (!card) {
    return (
      <p className="empty">
        <span className="spinner" aria-hidden="true" /> {t.loading}
      </p>
    );
  }

  const phone = card.phone_numbers[0];
  const updated = new Date(card.updated_at).toLocaleDateString(lang === 'he' ? 'he-IL' : lang);

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      await navigator.share({ title: card.service_name, url }).catch(() => {});
      return;
    }
    await navigator.clipboard?.writeText(url).catch(() => {});
    setShared(true);
  };

  return (
    <article className="detail">
      <h1>{card.service_name}</h1>

      <p className="meta">
        {card.national_service ? (
          <span className="tag national">{t.nationwide}</span>
        ) : (
          card.city && <span className="where">{card.city}</span>
        )}
      </p>

      {card.service_description && <p className="lead">{card.service_description}</p>}

      {card.situations && card.situations.length > 0 && (
        <section>
          <h2>{t.suitableFor}</h2>
          <div className="chips">
            {card.situations.map((s) => (
              <span key={s.id} className="tag">
                {s.name ?? s.id}
              </span>
            ))}
          </div>
        </section>
      )}

      {card.service_details && (
        <section>
          <h2>{t.practicalInfo}</h2>
          <p>{card.service_details}</p>
        </section>
      )}

      <section>
        <h2>{t.conditions}</h2>
        <p>{card.payment_required ? (card.payment_details ?? t.paymentRequired) : t.free}</p>
      </section>

      <section>
        <h2>{t.whereAndWhen}</h2>
        {card.national_service ? (
          <p>{t.nationwideNote}</p>
        ) : (
          <>
            <p>
              {card.address}
              {card.address_details ? ` — ${card.address_details}` : ''}
            </p>
            {!card.location_accurate && <p className="notice">{t.approximateLocation}</p>}
          </>
        )}
      </section>

      <section>
        <h2>{t.providedBy}</h2>
        <p>
          {card.organization_name}
          {card.organization_branch_count > 1 && ` · ${t.branches(card.organization_branch_count)}`}
        </p>
        {card.organization_purpose && <p className="desc">{card.organization_purpose}</p>}
        {(card.organization_urls ?? []).slice(0, 2).map((u) => (
          <p key={u.href}>
            <a href={u.href} target="_blank" rel="noreferrer noopener">
              {u.title ?? t.website}
            </a>
          </p>
        ))}
      </section>

      {card.also_at_this_branch && card.also_at_this_branch.length > 0 && (
        <section>
          <h2>{t.moreAtThisPlace}</h2>
          <ul className="cards">
            {card.also_at_this_branch.map((s) => (
              <li key={s.card_id} className="card">
                <h3>
                  <Link to={`/s/${s.card_id}?lang=${lang}`}>{s.service_name}</Link>
                </h3>
                {s.service_description && <p className="desc">{s.service_description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Provenance is shown, not buried in a disclaimer. "Updated in March" is
          something a reader can act on; "may be inaccurate" is not. */}
      <p className="source">{t.sourceAndDate(updated)}</p>

      <ReportProblem cardId={card.card_id} lang={lang} />

      <div className="sticky-actions">
        {phone && (
          <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`} style={{ flex: 2 }}>
            {t.call} {phone}
          </a>
        )}
        <button type="button" className="btn secondary" aria-pressed={saved.includes(card.card_id)} onClick={() => toggleSave(card.card_id)}>
          {saved.includes(card.card_id) ? `✓ ${t.saved}` : t.save}
        </button>
        <button type="button" className="btn secondary" onClick={share}>
          {shared ? t.shareCopied : t.share}
        </button>
      </div>
    </article>
  );
}

export function SavedPage({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);
  const [saved, toggleSave] = useSaved();
  const [cards, setCards] = useState<CardDetail[]>([]);

  useEffect(() => {
    Promise.all(saved.map((id) => getCard(id, lang).catch(() => null)))
      .then((list) => setCards(list.filter((c): c is CardDetail => c !== null)));
  }, [saved.join(','), lang]);

  if (saved.length === 0) {
    return (
      <div className="empty">
        <h1>{t.myFolderEmpty}</h1>
        <p>{t.myFolderBody}</p>
        <Link className="btn" to={`/?lang=${lang}`}>
          {t.back}
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1>{t.myFolder}</h1>
      <ul className="cards">
        {cards.map((card) => (
          <ActionCard key={card.card_id} card={card} lang={lang} saved onToggleSave={toggleSave} />
        ))}
      </ul>
    </>
  );
}

/**
 * The correction path.
 *
 * Whoever just phoned a disconnected number is the only person who knows it is
 * disconnected, so the form asks for one sentence and nothing else. Requiring a
 * name or an email here would mean hearing about far fewer dead numbers.
 */
function ReportProblem({ cardId, lang }: { cardId: string; lang: Lang }) {
  const t = stringsFor(lang);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) return <p className="notice">{t.reportErrorThanks}</p>;

  if (!open) {
    return (
      <button type="button" className="btn secondary block" onClick={() => setOpen(true)}>
        {t.reportError}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (message.trim().length < 3) return;
        reportError({ card_id: cardId, message: message.trim() })
          .then(() => setSent(true))
          .catch(() => setSent(true));
      }}
    >
      <h2>{t.reportErrorTitle}</h2>
      <label htmlFor="report" className="visually-hidden">
        {t.reportErrorBody}
      </label>
      <textarea
        id="report"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={t.reportErrorBody}
        rows={3}
        style={{
          width: '100%',
          font: 'inherit',
          padding: '0.6rem',
          borderRadius: 'var(--radius)',
          border: '2px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--fg)',
        }}
      />
      <button type="submit" className="btn block" style={{ marginTop: '0.5rem' }}>
        {t.reportErrorSend}
      </button>
    </form>
  );
}
