import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Card } from './api.js';
import { LANG_NAMES, LANGS, type Lang, stringsFor } from './i18n.js';

/**
 * A result is meant to be acted on where it stands.
 *
 * The reason is the situation this is used in: someone who needs a food parcel
 * needs a phone number, not a detail page and then a phone number. Every card
 * therefore carries what it is, who it is for, where it is, and a way to make
 * contact, and the detail page is for the questions that remain.
 */
export function ActionCard({
  card,
  lang,
  saved,
  onToggleSave,
}: {
  card: Card;
  lang: Lang;
  saved: boolean;
  onToggleSave: (cardId: string) => void;
}) {
  const t = stringsFor(lang);
  const phone = card.phone_numbers[0];
  const distanceKm = card.distance_m != null ? (card.distance_m / 1000).toFixed(1) : null;

  return (
    <li className="card">
      <h3>
        <Link to={`/s/${card.card_id}${window.location.search}`}>{card.service_name}</Link>
      </h3>

      {card.service_description && <p className="desc">{card.service_description}</p>}

      <div className="meta">
        {card.national_service ? (
          <span className="tag national">{t.nationwide}</span>
        ) : (
          <>
            {card.city && <span className="where">{card.city}</span>}
            {distanceKm && <span>{t.distanceAway(distanceKm)}</span>}
          </>
        )}
        <span>{card.organization_short_name ?? card.organization_name}</span>
        {card.other_organizations > 0 ? (
          <span>{t.alsoOfferedBy(card.other_organizations)}</span>
        ) : (
          card.also_available_at > 0 && <span>{t.alsoAvailableAt(card.also_available_at)}</span>
        )}
      </div>

      {/* A pin that is only a city centroid must say so. Sending someone to the
          wrong street is worse than telling them to call first. */}
      {!card.national_service && !card.location_accurate && card.city && (
        <p className="notice">{t.approximateLocation}</p>
      )}

      <div className="actions">
        {phone && (
          <a className="btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
            {t.call} {phone}
          </a>
        )}
        {!card.national_service && card.lat != null && card.lon != null && (
          <a
            className="btn secondary"
            href={`https://www.google.com/maps/search/?api=1&query=${card.lat},${card.lon}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t.directions}
          </a>
        )}
        <button
          type="button"
          className="btn secondary"
          aria-pressed={saved}
          onClick={() => onToggleSave(card.card_id)}
        >
          {saved ? `✓ ${t.saved}` : t.save}
        </button>
      </div>
    </li>
  );
}

/**
 * The urgent path, always one tap away.
 *
 * Kept out of the ranked results entirely. Someone in immediate danger should
 * not have to read a list, compare options or understand a taxonomy.
 *
 * Deliberately small: this site is for finding a service, and the emergency
 * lines are a safety net beside that, not the thing the page is about. The
 * numbers are still one tap away, with no button to press first — they are
 * simply a compact strip rather than a panel.
 */
export function UrgentBar({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);

  // Nationally published, permanently staffed lines. Hard-coded rather than
  // queried, because this must work even when the database does not.
  const lines: { name: string; phone: string }[] = [
    { name: lang === 'ar' ? 'الشرطة' : lang === 'ru' ? 'Полиция' : lang === 'en' ? 'Police' : 'משטרה', phone: '100' },
    { name: lang === 'ar' ? 'إسعاف' : lang === 'ru' ? 'Скорая' : lang === 'en' ? 'Ambulance' : 'מד״א', phone: '101' },
    {
      name: lang === 'ar' ? 'ער"ن' : lang === 'ru' ? 'ЭРАН' : lang === 'en' ? 'ERAN' : 'ער״ן',
      phone: '1201',
    },
    {
      name: lang === 'ar' ? 'عنف أسري' : lang === 'ru' ? 'Насилие в семье' : lang === 'en' ? 'Domestic violence' : 'אלימות במשפחה',
      phone: '118',
    },
  ];

  return (
    <section className="urgent" aria-labelledby="urgent-heading">
      <h2 id="urgent-heading">{t.urgentHelp}</h2>
      <ul>
        {lines.map((l) => (
          <li key={l.phone}>
            <a href={`tel:${l.phone}`}>
              {l.name} {l.phone}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LangSwitch({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  const t = stringsFor(lang);
  return (
    <label className="iconbtn">
      <span className="visually-hidden">{t.language}</span>
      <select
        value={lang}
        onChange={(e) => onChange(e.target.value as Lang)}
        style={{ font: 'inherit', border: 0, background: 'none', color: 'inherit' }}
      >
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {LANG_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Saved services.
 *
 * Held in the browser and nowhere else. A list of the shelters and food banks
 * someone looked at is sensitive, and the site is more useful if it never has
 * to ask who they are.
 */
export function useSaved(): [string[], (cardId: string) => void] {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('saved') ?? '[]') as string[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('saved', JSON.stringify(ids));
    } catch {
      // Storage may be unavailable; the list simply does not survive the visit.
    }
  }, [ids]);

  const toggle = (cardId: string) =>
    setIds((current) =>
      current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId],
    );

  return [ids, toggle];
}

/** Requests the browser's location, reporting each state the caller must show. */
export function useGeolocation() {
  const [state, setState] = useState<{
    status: 'idle' | 'working' | 'ready' | 'denied';
    lat?: number;
    lon?: number;
  }>({ status: 'idle' });

  const request = () => {
    if (!navigator.geolocation) {
      setState({ status: 'denied' });
      return;
    }
    setState({ status: 'working' });
    navigator.geolocation.getCurrentPosition(
      (pos) => setState({ status: 'ready', lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => setState({ status: 'denied' }),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  return { ...state, request };
}
