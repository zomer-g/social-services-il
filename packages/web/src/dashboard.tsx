import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Lang } from './i18n.js';

/**
 * The analysis dashboard.
 *
 * The search is for someone who needs one service. This page is for whoever is
 * asking about all of them: which regions have fewer services per resident,
 * which needs go unmet where, who actually runs the services, and how much of
 * the record can be trusted.
 *
 * The whole corpus arrives once from /api/v1/analytics and every chart is
 * computed here, in the browser, as filters change. Filters live in the URL, so
 * any view can be shared as a link. Each chart is filtered by every filter
 * except its own — the district chart still shows all districts while one is
 * selected, with that one marked — which is what lets a click on a bar act as a
 * filter without the chart collapsing to a single bar.
 */

type Sector = 'jewish' | 'arab' | 'bedouin' | 'mixed';

interface Payload {
  generated_at: string;
  sources: { localities: { resource: string; column: string; url: string } };
  districts: string[];
  district_population: number[];
  sector_population: Record<Sector, number>;
  uncovered: [string, number, number, Sector | null][];
  kinds: string[];
  taxonomy: { id: string; axis: 'response' | 'situation'; parent: number; name: string }[];
  orgs: { name: string; kind: number }[];
  cities: {
    name: string;
    district: number;
    subdistrict: string | null;
    population: number | null;
    sector: Sector | null;
    match: 'cbs' | 'nearest' | 'none';
    lat: number | null;
    lon: number | null;
  }[];
  cards: {
    service: number[];
    org: number[];
    city: number[];
    national: number[];
    accurate: number[];
    phone: number[];
    lat: (number | null)[];
    lon: (number | null)[];
    responses: number[][];
    situations: number[][];
  };
}

// ---------------------------------------------------------------- strings

const HE = {
  title: 'ניתוח נתונים',
  lead: 'כל השירותים במאגר, בפילוח לפי תחום, אוכלוסייה, אזור וארגון. לחיצה על עמודה או על תא מסננת את כל הדף, והקישור שומר את הסינון.',
  loading: 'טוען את המאגר…',
  failed: 'לא הצלחנו לטעון את הנתונים.',
  tabs: { overview: 'סקירה', regions: 'אזורים ויישובים', matrix: 'מטריצות כיסוי', quality: 'איכות הנתונים' },
  filters: 'סינון',
  district: 'מחוז',
  sector: 'סוג יישוב',
  kind: 'סוג ארגון',
  scope: 'היקף',
  all: 'הכול',
  scopeAll: 'מקומי וארצי',
  scopeLocal: 'מקומי בלבד',
  scopeNational: 'ארצי בלבד',
  clear: 'ניקוי הסינון',
  domain: 'תחום',
  population: 'אוכלוסיית יעד',
  town: 'יישוב',
  sectors: { jewish: 'יהודי', arab: 'ערבי', bedouin: 'בדואי', mixed: 'מעורב' } as Record<Sector, string>,
  unknownKind: 'לא צוין',
  kpi: {
    points: 'נקודות שירות',
    pointsNote: 'שירות במקום מסוים',
    services: 'שירותים',
    orgs: 'ארגונים',
    towns: 'יישובים',
    per10k: 'ל־10,000 תושבים',
    per10kNote: 'נקודות מקומיות',
    national: 'שירותים ארציים',
    phone: 'עם טלפון',
  },
  domains: 'תחומי שירות',
  domainsSub: 'כמה נקודות שירות בכל תחום. לחיצה על תחום נכנסת לתתי־התחומים שלו.',
  populations: 'למי השירות מיועד',
  populationsSub: 'אוכלוסיות היעד. שירות אחד יכול להיות מסווג לכמה.',
  up: 'חזרה לרמה העליונה',
  kinds: 'מי מפעיל',
  kindsSub: 'נקודות השירות לפי סוג הארגון המפעיל.',
  topOrgs: 'הארגונים הגדולים',
  topOrgsSub: 'לפי מספר נקודות השירות בסינון הנוכחי.',
  org: 'ארגון',
  points: 'נקודות',
  towns: 'יישובים',
  domainsCount: 'תחומים',
  districts: 'מחוזות',
  districtsSub: 'נקודות שירות מקומיות ל־10,000 תושבים, לפי אוכלוסיית המחוז בלמ״ס.',
  map: 'מפת נקודות השירות',
  mapSub: 'כל נקודה היא שירות במקום. אפור — כל המאגר; צבע — הסינון הנוכחי. לחיצה על יישוב מסננת לפיו.',
  sectorsTitle: 'לפי סוג יישוב',
  sectorsSub: 'נקודות מקומיות ל־10,000 תושבים, לפי סיווג היישוב בלמ״ס (דת יישוב).',
  townsTitle: 'יישובים',
  townsSub: 'מיון לפי כל עמודה. "ל־1,000" מחושב רק ליישובים שנמצאו בקובץ הלמ״ס.',
  searchTown: 'חיפוש יישוב',
  minPop: 'אוכלוסייה מינימלית',
  any: 'כל גודל',
  pop: 'תושבים',
  per1k: 'ל־1,000',
  coverage: 'כיסוי תחומים',
  more: 'עוד',
  gaps: 'יישובים ללא שירות בסינון הזה',
  gapsSub: (min: string) =>
    `יישובים של ${min} תושבים ומעלה שאין בהם אף נקודת שירות מקומית שעונה על הסינון. שירותים ארציים ושירותים של מועצה אזורית הניתנים ממקום אחר אינם נספרים.`,
  noGaps: 'לכל היישובים בגודל הזה יש לפחות נקודת שירות אחת בסינון הנוכחי.',
  matrixDistrict: 'מחוז × תחום: מדד כיסוי',
  matrixDistrictSub:
    'נקודות מקומיות לתושב בכל מחוז ותחום, ביחס לממוצע הארצי של אותו תחום. 100 = כמו הממוצע; 50 = מחצית; 200 = פי שניים. לחיצה על תא מסננת.',
  matrixCross: 'אוכלוסייה × תחום',
  matrixCrossSub: 'מבין השירותים לכל אוכלוסייה (שורה) — איזה אחוז עוסק בכל תחום (עמודה). סינון לפי תחום או אוכלוסייה פותח את הרמה שמתחתיו.',
  legendBelow: 'מתחת לממוצע',
  legendAbove: 'מעל לממוצע',
  legendAvg: 'סביב הממוצע',
  quality: 'שלמות הרשומות לפי מחוז',
  qualitySub: 'איזה חלק מנקודות השירות כולל כל פרט. ככל שהאחוז נמוך, כך קשה יותר לפנות לשירות.',
  qPhone: 'טלפון',
  qExact: 'מיקום מדויק',
  qSituation: 'אוכלוסיית יעד',
  qKind: 'סוג ארגון',
  matching: 'שיוך יישובים למחוזות',
  matchingSub: 'שם היישוב בכל רשומה הותאם לקובץ היישובים של הלמ״ס. יישוב שלא נמצא לפי שמו שויך למחוז של היישוב הקרוב אליו (עד 12 ק״מ), בלי אוכלוסייה.',
  mCbs: 'נמצאו בקובץ הלמ״ס',
  mNearest: 'שויכו לפי היישוב הקרוב',
  mNone: 'לא שויכו',
  sources: 'מקורות',
  sourcesBody: 'שירותים: המאגר של האתר. אוכלוסייה, מחוזות וסוג יישוב: ',
  cbs: 'קובץ היישובים של הלמ״ס',
  updated: (d: string) => `הנתונים חושבו ב־${d}`,
  outside: 'לא ידוע',
  noData: 'אין נתונים בסינון הזה',
  national: 'ארצי',
};

type Strings = typeof HE;

const EN: Strings = {
  title: 'Data dashboard',
  lead: 'Every service in the directory, broken down by field, target population, region and organisation. Clicking a bar or a cell filters the whole page, and the link keeps the filter.',
  loading: 'Loading the directory…',
  failed: 'Could not load the data.',
  tabs: { overview: 'Overview', regions: 'Regions & towns', matrix: 'Coverage matrices', quality: 'Data quality' },
  filters: 'Filters',
  district: 'District',
  sector: 'Town type',
  kind: 'Organisation type',
  scope: 'Scope',
  all: 'All',
  scopeAll: 'Local and national',
  scopeLocal: 'Local only',
  scopeNational: 'National only',
  clear: 'Clear filters',
  domain: 'Field',
  population: 'Target population',
  town: 'Town',
  sectors: { jewish: 'Jewish', arab: 'Arab', bedouin: 'Bedouin', mixed: 'Mixed' },
  unknownKind: 'Not stated',
  kpi: {
    points: 'Service points',
    pointsNote: 'a service at a place',
    services: 'Services',
    orgs: 'Organisations',
    towns: 'Towns',
    per10k: 'Per 10,000 residents',
    per10kNote: 'local points',
    national: 'National services',
    phone: 'With a phone',
  },
  domains: 'Fields of service',
  domainsSub: 'Service points in each field. Click a field to open its sub-fields.',
  populations: 'Who it is for',
  populationsSub: 'Target populations. One service can be for several.',
  up: 'Back to the top level',
  kinds: 'Who runs it',
  kindsSub: 'Service points by the type of organisation running them.',
  topOrgs: 'Largest organisations',
  topOrgsSub: 'By service points in the current filter.',
  org: 'Organisation',
  points: 'Points',
  towns: 'Towns',
  domainsCount: 'Fields',
  districts: 'Districts',
  districtsSub: 'Local service points per 10,000 residents, using the CBS district population.',
  map: 'Map of service points',
  mapSub: 'Each dot is a service at a place. Grey — the whole directory; colour — the current filter. Click a town to filter by it.',
  sectorsTitle: 'By town type',
  sectorsSub: 'Local points per 10,000 residents, by the CBS town classification.',
  townsTitle: 'Towns',
  townsSub: 'Sort by any column. "Per 1,000" is only computed for towns found in the CBS file.',
  searchTown: 'Find a town',
  minPop: 'Minimum population',
  any: 'Any size',
  pop: 'Residents',
  per1k: 'Per 1,000',
  coverage: 'Fields covered',
  more: 'More',
  gaps: 'Towns with no service in this filter',
  gapsSub: (min: string) =>
    `Towns of ${min} residents or more with not one local service point matching the filter. National services, and regional-council services run from elsewhere, are not counted.`,
  noGaps: 'Every town of this size has at least one service point in the current filter.',
  matrixDistrict: 'District × field: coverage index',
  matrixDistrictSub:
    'Local points per resident in each district and field, against the national rate for that field. 100 = the national rate; 50 = half; 200 = double. Click a cell to filter.',
  matrixCross: 'Population × field',
  matrixCrossSub: 'Of the services for each population (row), the share in each field (column). Filtering by a field or population opens the level beneath it.',
  legendBelow: 'Below the average',
  legendAbove: 'Above the average',
  legendAvg: 'Around the average',
  quality: 'Record completeness by district',
  qualitySub: 'The share of service points that include each detail. The lower it is, the harder the service is to reach.',
  qPhone: 'Phone',
  qExact: 'Exact location',
  qSituation: 'Target population',
  qKind: 'Organisation type',
  matching: 'Placing towns in districts',
  matchingSub: 'Each record’s town name was matched to the CBS localities file. A town not found by name took the district of the nearest town that was (up to 12 km), without a population.',
  mCbs: 'Found in the CBS file',
  mNearest: 'Placed by nearest town',
  mNone: 'Not placed',
  sources: 'Sources',
  sourcesBody: 'Services: this site’s directory. Population, districts and town type: ',
  cbs: 'the CBS localities file',
  updated: (d: string) => `Computed on ${d}`,
  outside: 'Unknown',
  noData: 'No data in this filter',
  national: 'National',
};

const stringsFor = (lang: Lang): Strings => (lang === 'he' ? HE : EN);
const locale = (lang: Lang) => ({ he: 'he-IL', ar: 'ar', ru: 'ru-RU', en: 'en-GB' })[lang];

// ---------------------------------------------------------------- model

interface Model {
  p: Payload;
  n: number;
  /** Top-level ancestor of every taxonomy node. */
  root: number[];
  children: number[][];
  roots: { response: number[]; situation: number[] };
  /** Each card's categories with all their ancestors, deduplicated. */
  respAll: number[][];
  sitAll: number[][];
  cardDistrict: number[];
  cardSector: (Sector | null)[];
  totalPopulation: number;
  byId: Map<string, number>;
}

function prepare(p: Payload): Model {
  const tax = p.taxonomy;
  const root = tax.map((_, i) => {
    let x = i;
    for (let guard = 0; tax[x]!.parent >= 0 && guard < 20; guard++) x = tax[x]!.parent;
    return x;
  });
  const children: number[][] = tax.map(() => []);
  const roots = { response: [] as number[], situation: [] as number[] };
  tax.forEach((node, i) => {
    if (node.parent >= 0) children[node.parent]!.push(i);
    else roots[node.axis].push(i);
  });
  const withAncestors = (ids: number[]) => {
    const out = new Set<number>();
    for (const id of ids) {
      let x = id;
      for (let guard = 0; x >= 0 && guard < 20; guard++) {
        out.add(x);
        x = tax[x]!.parent;
      }
    }
    return [...out];
  };
  const c = p.cards;
  return {
    p,
    n: c.org.length,
    root,
    children,
    roots,
    respAll: c.responses.map(withAncestors),
    sitAll: c.situations.map(withAncestors),
    cardDistrict: c.city.map((ci) => (ci >= 0 ? p.cities[ci]!.district : -1)),
    cardSector: c.city.map((ci) => (ci >= 0 ? p.cities[ci]!.sector : null)),
    totalPopulation: p.district_population.reduce((a, b) => a + (b ?? 0), 0),
    byId: new Map(tax.map((t, i) => [t.id, i])),
  };
}

type Dim = 'd' | 'sec' | 'r' | 's' | 'k' | 'scope' | 'town';

interface Filters {
  d: number;
  sec: Sector | '';
  r: number;
  s: number;
  k: number;
  scope: '' | 'local' | 'national';
  town: number;
}

function passes(m: Model, f: Filters, i: number, except?: Dim): boolean {
  const c = m.p.cards;
  if (except !== 'scope' && f.scope) {
    if (f.scope === 'local' && c.national[i]) return false;
    if (f.scope === 'national' && !c.national[i]) return false;
  }
  if (except !== 'd' && f.d >= 0 && m.cardDistrict[i] !== f.d) return false;
  if (except !== 'sec' && f.sec && m.cardSector[i] !== f.sec) return false;
  if (except !== 'town' && f.town >= 0 && c.city[i] !== f.town) return false;
  if (except !== 'k' && f.k >= 0 && m.p.orgs[c.org[i]!]!.kind !== f.k) return false;
  if (except !== 'r' && f.r >= 0 && !m.respAll[i]!.includes(f.r)) return false;
  if (except !== 's' && f.s >= 0 && !m.sitAll[i]!.includes(f.s)) return false;
  return true;
}

function select(m: Model, f: Filters, except?: Dim): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.n; i++) if (passes(m, f, i, except)) out.push(i);
  return out;
}

/** Counts cards per key, where each card may contribute to several keys once each. */
function countBy(idx: number[], keys: (i: number) => Iterable<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const i of idx) for (const k of keys(i)) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

// ---------------------------------------------------------------- page

type Tab = 'overview' | 'regions' | 'matrix' | 'quality';
const TABS: Tab[] = ['overview', 'regions', 'matrix', 'quality'];

export function DashboardPage({ lang }: { lang: Lang }) {
  const t = stringsFor(lang);
  const [data, setData] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    setData(null);
    setError(null);
    const controller = new AbortController();
    fetch(`/api/v1/analytics?lang=${lang}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Payload>;
      })
      .then((p) => setData(prepare(p)))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [lang]);

  const tab: Tab = (TABS as string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';

  if (error) return <p className="notice">{t.failed}</p>;
  if (!data) {
    return (
      <div className="dash">
        <DashHeader t={t} />
        <p className="empty">
          <span className="spinner" aria-hidden="true" /> {t.loading}
        </p>
      </div>
    );
  }

  const m = data;
  const f = readFilters(m, params);

  const update = (patch: Partial<Record<Dim | 'tab', string | null>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="dash">
      <DashHeader t={t} />

      <div className="dashtabs" role="tablist" aria-label={t.title}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="dashtab"
            onClick={() => update({ tab: id === 'overview' ? null : id })}
          >
            {t.tabs[id]}
          </button>
        ))}
      </div>

      <FilterBar m={m} f={f} t={t} update={update} />

      <div role="tabpanel">
        <Kpis m={m} f={f} t={t} lang={lang} />
        {tab === 'overview' && <Overview m={m} f={f} t={t} lang={lang} update={update} />}
        {tab === 'regions' && <Regions m={m} f={f} t={t} lang={lang} update={update} />}
        {tab === 'matrix' && <Matrices m={m} f={f} t={t} lang={lang} update={update} />}
        {tab === 'quality' && <Quality m={m} f={f} t={t} lang={lang} />}
      </div>

      <p className="dash-source">
        {t.sources}: {t.sourcesBody}
        <a href={m.p.sources.localities.url} target="_blank" rel="noreferrer noopener">
          {t.cbs}
        </a>{' '}
        ({m.p.sources.localities.column}). {t.updated(new Date(m.p.generated_at).toLocaleString(locale(lang)))}
      </p>
    </div>
  );
}

function DashHeader({ t }: { t: Strings }) {
  return (
    <header className="dash-head">
      <h1>{t.title}</h1>
      <p>{t.lead}</p>
    </header>
  );
}

function readFilters(m: Model, params: URLSearchParams): Filters {
  const tax = (key: string, axis: 'response' | 'situation') => {
    const i = m.byId.get(params.get(key) ?? '');
    return i !== undefined && m.p.taxonomy[i]!.axis === axis ? i : -1;
  };
  const sec = params.get('sec') ?? '';
  const scope = params.get('scope') ?? '';
  return {
    d: m.p.districts.indexOf(params.get('d') ?? '\0'),
    sec: (['jewish', 'arab', 'bedouin', 'mixed'].includes(sec) ? sec : '') as Filters['sec'],
    r: tax('r', 'response'),
    s: tax('s', 'situation'),
    k: m.p.kinds.indexOf(params.get('k') ?? '\0'),
    scope: (scope === 'local' || scope === 'national' ? scope : '') as Filters['scope'],
    town: m.p.cities.findIndex((c) => c.name === params.get('town')),
  };
}

type Update = (patch: Partial<Record<Dim | 'tab', string | null>>) => void;
interface ViewProps {
  m: Model;
  f: Filters;
  t: Strings;
  lang: Lang;
  update: Update;
}

// ---------------------------------------------------------------- filters

function FilterBar({ m, f, t, update }: Omit<ViewProps, 'lang'>) {
  const p = m.p;
  const kindLabel = (k: string) => k || t.unknownKind;
  const active: { key: Dim; label: string; value: string }[] = [];
  if (f.r >= 0) active.push({ key: 'r', label: t.domain, value: p.taxonomy[f.r]!.name });
  if (f.s >= 0) active.push({ key: 's', label: t.population, value: p.taxonomy[f.s]!.name });
  if (f.town >= 0) active.push({ key: 'town', label: t.town, value: p.cities[f.town]!.name });
  const any = active.length > 0 || f.d >= 0 || !!f.sec || f.k >= 0 || !!f.scope;
  const sectors = (Object.keys(t.sectors) as Sector[]).filter((s) => p.sector_population[s] > 0);

  return (
    <section className="filterbar" aria-label={t.filters}>
      <div className="filterrow">
        <label>
          <span>{t.district}</span>
          <select value={f.d >= 0 ? p.districts[f.d] : ''} onChange={(e) => update({ d: e.target.value })}>
            <option value="">{t.all}</option>
            {p.districts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t.sector}</span>
          <select value={f.sec} onChange={(e) => update({ sec: e.target.value })}>
            <option value="">{t.all}</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {t.sectors[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t.kind}</span>
          <select value={f.k >= 0 ? p.kinds[f.k] : '\0'} onChange={(e) => update({ k: e.target.value === '\0' ? null : e.target.value })}>
            <option value={'\0'}>{t.all}</option>
            {p.kinds
              .map((k, i) => ({ k, i }))
              .sort((a, b) => kindLabel(a.k).localeCompare(kindLabel(b.k)))
              .map(({ k }) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>{t.scope}</span>
          <select value={f.scope} onChange={(e) => update({ scope: e.target.value })}>
            <option value="">{t.scopeAll}</option>
            <option value="local">{t.scopeLocal}</option>
            <option value="national">{t.scopeNational}</option>
          </select>
        </label>
        {any && (
          <button
            type="button"
            className="btn secondary clearall"
            onClick={() => update({ d: null, sec: null, k: null, scope: null, r: null, s: null, town: null })}
          >
            {t.clear}
          </button>
        )}
      </div>
      {active.length > 0 && (
        <div className="chips activefilters">
          {active.map((a) => (
            <button key={a.key} type="button" className="chip" aria-pressed="true" onClick={() => update({ [a.key]: null })}>
              <span className="chiplabel">{a.label}:</span> {a.value} <span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- KPIs

function Kpis({ m, f, t, lang }: Omit<ViewProps, 'update'>) {
  const nf = new Intl.NumberFormat(locale(lang));
  const pct = new Intl.NumberFormat(locale(lang), { style: 'percent', maximumFractionDigits: 0 });
  const stats = useMemo(() => {
    const idx = select(m, f);
    const c = m.p.cards;
    const services = new Set<number>();
    const orgs = new Set<number>();
    const towns = new Set<number>();
    let national = 0;
    let phone = 0;
    let local = 0;
    for (const i of idx) {
      services.add(c.service[i]!);
      orgs.add(c.org[i]!);
      if (c.city[i]! >= 0) towns.add(c.city[i]!);
      if (c.national[i]) national++;
      else local++;
      if (c.phone[i]) phone++;
    }
    // The denominator follows the geographic filter: a district's people, a
    // sector's, a town's, or everyone.
    let population = m.totalPopulation;
    if (f.town >= 0) population = m.p.cities[f.town]!.population ?? 0;
    else if (f.d >= 0 && !f.sec) population = m.p.district_population[f.d] ?? 0;
    else if (f.sec && f.d < 0) population = m.p.sector_population[f.sec];
    else if (f.sec && f.d >= 0) population = 0;
    return { total: idx.length, services: services.size, orgs: orgs.size, towns: towns.size, national, phone, local, population };
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const per10k = stats.population > 0 && f.scope !== 'national' ? (stats.local / stats.population) * 10_000 : null;

  return (
    <div className="kpis">
      <Kpi label={t.kpi.points} value={nf.format(stats.total)} note={t.kpi.pointsNote} />
      <Kpi label={t.kpi.services} value={nf.format(stats.services)} />
      <Kpi label={t.kpi.orgs} value={nf.format(stats.orgs)} />
      <Kpi label={t.kpi.towns} value={nf.format(stats.towns)} />
      <Kpi label={t.kpi.per10k} value={per10k == null ? '—' : per10k.toFixed(1)} note={t.kpi.per10kNote} />
      <Kpi label={t.kpi.national} value={stats.total ? pct.format(stats.national / stats.total) : '—'} />
      <Kpi label={t.kpi.phone} value={stats.total ? pct.format(stats.phone / stats.total) : '—'} />
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {note && <span className="kpi-note">{note}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- building blocks

function Panel({ title, sub, children, wide, actions }: { title: string; sub?: string; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  return (
    <section className={wide ? 'panel wide' : 'panel'}>
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="panel-sub">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

interface Bar {
  key: string | number;
  label: string;
  value: number;
  display?: string;
  note?: string;
  selected?: boolean;
  onClick?: () => void;
}

/**
 * A horizontal bar list. Each row is a button when it filters, and carries its
 * number in text beside the bar, so nothing depends on reading a length.
 */
function BarList({ bars, empty, max }: { bars: Bar[]; empty: string; max?: number }) {
  if (bars.length === 0) return <p className="muted">{empty}</p>;
  const top = max ?? Math.max(...bars.map((b) => b.value), 1);
  return (
    <ul className="bars">
      {bars.map((b) => {
        const inner = (
          <>
            <span className="bar-label">
              {b.label}
              {b.note && <span className="bar-note"> · {b.note}</span>}
            </span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar-fill" style={{ inlineSize: `${Math.max((b.value / top) * 100, b.value > 0 ? 1.5 : 0)}%` }} />
            </span>
            <span className="bar-value">{b.display ?? b.value}</span>
          </>
        );
        return (
          <li key={b.key} className={b.selected ? 'selected' : undefined}>
            {b.onClick ? (
              <button type="button" className="bar-row" aria-pressed={b.selected ?? false} onClick={b.onClick}>
                {inner}
              </button>
            ) : (
              <div className="bar-row">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- overview

function TaxonomyBars({ m, f, t, lang, update, axis }: ViewProps & { axis: 'response' | 'situation' }) {
  const nf = new Intl.NumberFormat(locale(lang));
  const key: Dim = axis === 'response' ? 'r' : 's';
  const current = axis === 'response' ? f.r : f.s;
  const bars = useMemo(() => {
    // Inside a selection the chart shows the level beneath it, among the cards
    // the selection kept; at the top it shows the top level among everything.
    const idx = select(m, f, current >= 0 ? undefined : key);
    const level = current >= 0 ? m.children[current]! : m.roots[axis];
    const levelSet = new Set(level);
    const all = axis === 'response' ? m.respAll : m.sitAll;
    const counts = countBy(idx, (i) => all[i]!.filter((x) => levelSet.has(x)));
    return level
      .map((node) => ({ node, value: counts.get(node) ?? 0 }))
      .filter((b) => b.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 18);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town, axis]);

  const parent = current >= 0 ? m.p.taxonomy[current]!.parent : -1;
  return (
    <Panel
      title={`${axis === 'response' ? t.domains : t.populations}${current >= 0 ? ` · ${m.p.taxonomy[current]!.name}` : ''}`}
      sub={axis === 'response' ? t.domainsSub : t.populationsSub}
      actions={
        current >= 0 && (
          <button
            type="button"
            className="btn secondary small"
            onClick={() => update({ [key]: parent >= 0 ? m.p.taxonomy[parent]!.id : null })}
          >
            ↑ {t.up}
          </button>
        )
      }
    >
      <BarList
        empty={t.noData}
        bars={bars.map(({ node, value }) => ({
          key: node,
          label: m.p.taxonomy[node]!.name,
          value,
          display: nf.format(value),
          // A node with nothing beneath it cannot be opened further, so it is
          // shown but not offered as a button.
          onClick: m.children[node]!.length > 0 ? () => update({ [key]: m.p.taxonomy[node]!.id }) : undefined,
        }))}
      />
    </Panel>
  );
}

function Overview(props: ViewProps) {
  const { m, f, t, lang, update } = props;
  const nf = new Intl.NumberFormat(locale(lang));

  const kinds = useMemo(() => {
    const idx = select(m, f, 'k');
    const counts = countBy(idx, (i) => [m.p.orgs[m.p.cards.org[i]!]!.kind]);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const orgs = useMemo(() => {
    const idx = select(m, f);
    const c = m.p.cards;
    const agg = new Map<number, { points: number; towns: Set<number>; domains: Set<number> }>();
    for (const i of idx) {
      const o = c.org[i]!;
      let a = agg.get(o);
      if (!a) agg.set(o, (a = { points: 0, towns: new Set(), domains: new Set() }));
      a.points++;
      if (c.city[i]! >= 0) a.towns.add(c.city[i]!);
      for (const r of m.respAll[i]!) if (m.p.taxonomy[r]!.parent < 0) a.domains.add(r);
    }
    return [...agg.entries()].sort((a, b) => b[1].points - a[1].points).slice(0, 15);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  return (
    <div className="panels">
      <TaxonomyBars {...props} axis="response" />
      <TaxonomyBars {...props} axis="situation" />
      <Panel title={t.kinds} sub={t.kindsSub}>
        <BarList
          empty={t.noData}
          bars={kinds.map(([k, v]) => ({
            key: k,
            label: m.p.kinds[k] || t.unknownKind,
            value: v,
            display: nf.format(v),
            selected: f.k === k,
            onClick: () => update({ k: f.k === k ? null : m.p.kinds[k]! }),
          }))}
        />
      </Panel>
      <Panel title={t.topOrgs} sub={t.topOrgsSub}>
        {orgs.length === 0 ? (
          <p className="muted">{t.noData}</p>
        ) : (
          <div className="tablewrap">
            <table className="dtable">
              <thead>
                <tr>
                  <th scope="col">{t.org}</th>
                  <th scope="col" className="num">{t.points}</th>
                  <th scope="col" className="num">{t.towns}</th>
                  <th scope="col" className="num">{t.domainsCount}</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map(([o, a]) => (
                  <tr key={o}>
                    <td>
                      {m.p.orgs[o]!.name}
                      <span className="cell-note">{m.p.kinds[m.p.orgs[o]!.kind] || t.unknownKind}</span>
                    </td>
                    <td className="num">{nf.format(a.points)}</td>
                    <td className="num">{nf.format(a.towns.size)}</td>
                    <td className="num">{a.domains.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- regions

function Regions(props: ViewProps) {
  const { m, f, t, lang, update } = props;
  const nf = new Intl.NumberFormat(locale(lang));
  const p = m.p;

  const districts = useMemo(() => {
    const idx = select(m, f, 'd').filter((i) => !p.cards.national[i]);
    const counts = countBy(idx, (i) => (m.cardDistrict[i]! >= 0 ? [m.cardDistrict[i]!] : []));
    return p.districts
      .map((name, d) => {
        const count = counts.get(d) ?? 0;
        const pop = p.district_population[d] ?? 0;
        return { d, name, count, pop, rate: pop ? (count / pop) * 10_000 : 0 };
      })
      .sort((a, b) => b.rate - a.rate);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const sectors = useMemo(() => {
    const idx = select(m, f, 'sec').filter((i) => !p.cards.national[i]);
    const counts = new Map<Sector, number>();
    for (const i of idx) {
      const s = m.cardSector[i];
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return (Object.keys(p.sector_population) as Sector[])
      .filter((s) => p.sector_population[s] > 0)
      .map((s) => {
        const count = counts.get(s) ?? 0;
        return { s, count, rate: (count / p.sector_population[s]) * 10_000 };
      })
      .sort((a, b) => b.rate - a.rate);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  return (
    <div className="panels">
      <Panel title={t.map} sub={t.mapSub}>
        <MapView m={m} f={f} t={t} lang={lang} update={update} />
      </Panel>
      <div className="panelstack">
        <Panel title={t.districts} sub={t.districtsSub}>
          <BarList
            empty={t.noData}
            bars={districts.map((d) => ({
              key: d.d,
              label: d.name,
              value: d.rate,
              display: d.rate.toFixed(1),
              note: `${nf.format(d.count)} ${t.points}`,
              selected: f.d === d.d,
              onClick: () => update({ d: f.d === d.d ? null : d.name }),
            }))}
          />
        </Panel>
        <Panel title={t.sectorsTitle} sub={t.sectorsSub}>
          <BarList
            empty={t.noData}
            bars={sectors.map((s) => ({
              key: s.s,
              label: t.sectors[s.s],
              value: s.rate,
              display: s.rate.toFixed(1),
              note: `${nf.format(s.count)} ${t.points}`,
              selected: f.sec === s.s,
              onClick: () => update({ sec: f.sec === s.s ? null : s.s }),
            }))}
          />
        </Panel>
      </div>
      <TownsTable {...props} />
      <Gaps {...props} />
    </div>
  );
}

/** Israel's extent, for the map's projection. */
const BOUNDS = { minLat: 29.45, maxLat: 33.35, minLon: 34.2, maxLon: 35.95 };
const LON_SCALE = Math.cos((31.5 * Math.PI) / 180);

function MapView({ m, f, t, lang, update }: ViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ city: number; x: number; y: number } | null>(null);
  const p = m.p;
  const nf = new Intl.NumberFormat(locale(lang));

  const W = 360;
  const H = Math.round((W * (BOUNDS.maxLat - BOUNDS.minLat)) / ((BOUNDS.maxLon - BOUNDS.minLon) * LON_SCALE));
  const project = (lat: number, lon: number) => ({
    x: ((lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * W,
    y: ((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * H,
  });

  const idx = useMemo(() => select(m, f, 'town'), [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);
  const perCity = useMemo(() => countBy(idx, (i) => (p.cards.city[i]! >= 0 ? [p.cards.city[i]!] : [])), [idx]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = W * dpr;
    el.height = H * dpr;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(el);
    const base = css.getPropertyValue('--map-base').trim() || '#c8cdd4';
    const ink = css.getPropertyValue('--map-ink').trim() || '#0e5a57';
    const ring = css.getPropertyValue('--map-ring').trim() || '#111827';
    ctx.clearRect(0, 0, W, H);

    const c = p.cards;
    ctx.fillStyle = base;
    for (let i = 0; i < m.n; i++) {
      const lat = c.lat[i];
      const lon = c.lon[i];
      if (lat == null || lon == null) continue;
      const { x, y } = project(lat, lon);
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.55;
    for (const i of idx) {
      if (f.town >= 0 && c.city[i] !== f.town) continue;
      const lat = c.lat[i];
      const lon = c.lon[i];
      if (lat == null || lon == null) continue;
      const { x, y } = project(lat, lon);
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const mark = hover?.city ?? f.town;
    const city = mark >= 0 ? p.cities[mark] : undefined;
    if (city && city.lat != null && city.lon != null) {
      const { x, y } = project(city.lat, city.lon);
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [idx, hover?.city, f.town]);

  const nearest = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;
    let best = -1;
    let bestD = 10;
    p.cities.forEach((c, i) => {
      if (c.lat == null || c.lon == null || !perCity.get(i)) return;
      const q = project(c.lat, c.lon);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best >= 0 ? { city: best, x: ev.clientX - rect.left, y: ev.clientY - rect.top } : null;
  };

  const hovered = hover ? p.cities[hover.city] : undefined;
  const count = hover ? (perCity.get(hover.city) ?? 0) : 0;

  return (
    <div className="mapwrap">
      <canvas
        ref={canvas}
        className="map"
        style={{ aspectRatio: `${W} / ${H}` }}
        role="img"
        aria-label={t.mapSub}
        onMouseMove={(e) => setHover(nearest(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const h = nearest(e);
          if (h) update({ town: f.town === h.city ? null : p.cities[h.city]!.name });
        }}
      />
      {hovered && hover && (
        <div
          className="maptip"
          // Physical coordinates, since the pointer's are; the tip flips to the
          // other side of the pointer past the middle so it never leaves the map.
          style={{ left: hover.x, top: hover.y + 14, transform: hover.x > 190 ? 'translateX(-100%)' : undefined }}
        >
          <strong>{hovered.name}</strong>
          <span>
            {nf.format(count)} {t.points}
            {hovered.population ? ` · ${((count / hovered.population) * 1000).toFixed(1)} ${t.per1k}` : ''}
          </span>
          {hovered.district >= 0 && <span className="muted">{p.districts[hovered.district]}</span>}
        </div>
      )}
    </div>
  );
}

type TownSort = 'name' | 'pop' | 'points' | 'rate' | 'coverage';

function TownsTable({ m, f, t, lang, update }: ViewProps) {
  const nf = new Intl.NumberFormat(locale(lang));
  const p = m.p;
  const [sort, setSort] = useState<{ key: TownSort; desc: boolean }>({ key: 'points', desc: true });
  const [q, setQ] = useState('');
  const [minPop, setMinPop] = useState(0);
  const [limit, setLimit] = useState(25);

  const rows = useMemo(() => {
    const idx = select(m, f, 'town').filter((i) => p.cards.city[i]! >= 0);
    const agg = new Map<number, { points: number; domains: Set<number> }>();
    for (const i of idx) {
      const ci = p.cards.city[i]!;
      let a = agg.get(ci);
      if (!a) agg.set(ci, (a = { points: 0, domains: new Set() }));
      a.points++;
      for (const r of m.respAll[i]!) if (p.taxonomy[r]!.parent < 0) a.domains.add(r);
    }
    return [...agg.entries()].map(([ci, a]) => {
      const city = p.cities[ci]!;
      return {
        ci,
        name: city.name,
        district: city.district >= 0 ? p.districts[city.district]! : t.outside,
        pop: city.population,
        points: a.points,
        rate: city.population ? (a.points / city.population) * 1000 : null,
        coverage: a.domains.size,
      };
    });
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const shown = rows
    .filter((r) => (minPop ? (r.pop ?? 0) >= minPop : true))
    .filter((r) => !q.trim() || r.name.includes(q.trim()))
    .sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : ((av as number | null) ?? -1) - ((bv as number | null) ?? -1);
      return sort.desc ? -cmp : cmp;
    });

  const th = (key: TownSort, label: string, num = true) => (
    <th scope="col" className={num ? 'num' : undefined} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="sortbtn" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'name' })}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}</span>
      </button>
    </th>
  );
  const domainTotal = m.roots.response.length;

  return (
    <Panel title={t.townsTitle} sub={t.townsSub} wide>
      <div className="tabletools">
        <label>
          <span className="visually-hidden">{t.searchTown}</span>
          <input type="search" value={q} placeholder={t.searchTown} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          <span>{t.minPop}</span>
          <select value={minPop} onChange={(e) => setMinPop(Number(e.target.value))}>
            <option value={0}>{t.any}</option>
            {[5000, 20000, 50000, 100000].map((n) => (
              <option key={n} value={n}>
                {nf.format(n)}+
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="tablewrap">
        <table className="dtable">
          <thead>
            <tr>
              {th('name', t.town, false)}
              <th scope="col">{t.district}</th>
              {th('pop', t.pop)}
              {th('points', t.points)}
              {th('rate', t.per1k)}
              {th('coverage', t.coverage)}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r) => (
              <tr key={r.ci} className={f.town === r.ci ? 'selected' : undefined}>
                <td>
                  <button type="button" className="linkbtn" onClick={() => update({ town: f.town === r.ci ? null : r.name })}>
                    {r.name}
                  </button>
                </td>
                <td>{r.district}</td>
                <td className="num">{r.pop != null ? nf.format(r.pop) : '—'}</td>
                <td className="num">{nf.format(r.points)}</td>
                <td className="num">{r.rate != null ? r.rate.toFixed(1) : '—'}</td>
                <td className="num">
                  <span className="meter" aria-hidden="true">
                    <span style={{ inlineSize: `${(r.coverage / domainTotal) * 100}%` }} />
                  </span>
                  {r.coverage}/{domainTotal}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <button type="button" className="btn secondary block" onClick={() => setLimit(limit + 50)}>
          {t.more} ({nf.format(shown.length - limit)})
        </button>
      )}
    </Panel>
  );
}

function Gaps({ m, f, t, lang }: ViewProps) {
  const nf = new Intl.NumberFormat(locale(lang));
  const p = m.p;
  const [min, setMin] = useState(5000);

  const gaps = useMemo(() => {
    // Every town of this size the CBS counts, minus those with at least one
    // local point in the current filter. Filters on the town itself do not
    // apply: the question is about the others.
    const idx = select(m, f, 'town').filter((i) => !p.cards.national[i]);
    const served = new Set(idx.map((i) => p.cards.city[i]!));
    const out: { name: string; district: number; pop: number; sector: Sector | null }[] = [];
    p.cities.forEach((c, ci) => {
      if (c.match !== 'cbs' || c.population == null || c.population < min || served.has(ci)) return;
      out.push({ name: c.name, district: c.district, pop: c.population, sector: c.sector });
    });
    for (const [name, district, pop, sector] of p.uncovered) {
      if (pop >= min) out.push({ name, district, pop, sector });
    }
    return out
      .filter((g) => (f.d < 0 || g.district === f.d) && (!f.sec || g.sector === f.sec))
      .sort((a, b) => b.pop - a.pop);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, min]);

  return (
    <Panel
      title={t.gaps}
      sub={t.gapsSub(nf.format(min))}
      wide
      actions={
        <label className="inline-select">
          <span>{t.minPop}</span>
          <select value={min} onChange={(e) => setMin(Number(e.target.value))}>
            {[2000, 5000, 10000, 20000, 50000].map((n) => (
              <option key={n} value={n}>
                {nf.format(n)}+
              </option>
            ))}
          </select>
        </label>
      }
    >
      {gaps.length === 0 ? (
        <p className="muted">{t.noGaps}</p>
      ) : (
        <ul className="gaplist">
          {gaps.slice(0, 60).map((g) => (
            <li key={g.name}>
              <strong>{g.name}</strong>
              <span>
                {nf.format(g.pop)} {t.pop}
              </span>
              <span className="muted">
                {p.districts[g.district] ?? t.outside}
                {g.sector ? ` · ${t.sectors[g.sector]}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- matrices

/** Diverging bins for the coverage index; 100 is the national rate. */
function indexBin(ix: number): number {
  if (ix < 50) return 0;
  if (ix < 80) return 1;
  if (ix <= 125) return 2;
  if (ix <= 200) return 3;
  return 4;
}

function Matrices(props: ViewProps) {
  const { m, f, t, lang, update } = props;
  const nf = new Intl.NumberFormat(locale(lang));
  const p = m.p;

  // District × top-level field, local services only, normalised twice: per
  // resident, then against the national rate for the same field. Without the
  // second step every row would just repeat the district's overall density.
  const matrix = useMemo(() => {
    const idx = select(m, f, 'd').filter((i) => !p.cards.national[i]);
    const cols = f.r >= 0 && m.children[f.r]!.length > 0 ? m.children[f.r]! : m.roots.response;
    const colSet = new Set(cols);
    const cell = new Map<string, number>();
    const colTotal = new Map<number, number>();
    for (const i of idx) {
      const d = m.cardDistrict[i]!;
      if (d < 0) continue;
      for (const r of m.respAll[i]!) {
        if (!colSet.has(r)) continue;
        cell.set(`${d}:${r}`, (cell.get(`${d}:${r}`) ?? 0) + 1);
        colTotal.set(r, (colTotal.get(r) ?? 0) + 1);
      }
    }
    const shownCols = cols.filter((c) => (colTotal.get(c) ?? 0) > 0).sort((a, b) => (colTotal.get(b) ?? 0) - (colTotal.get(a) ?? 0)).slice(0, 14);
    return { cell, colTotal, cols: shownCols };
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const cross = useMemo(() => {
    const idx = select(m, f, 'r');
    const rows = f.s >= 0 && m.children[f.s]!.length > 0 ? m.children[f.s]! : m.roots.situation;
    const cols = f.r >= 0 && m.children[f.r]!.length > 0 ? m.children[f.r]! : m.roots.response;
    const rowSet = new Set(rows);
    const colSet = new Set(cols);
    const rowTotal = new Map<number, number>();
    const colTotal = new Map<number, number>();
    const cell = new Map<string, number>();
    for (const i of idx) {
      const rs = m.sitAll[i]!.filter((x) => rowSet.has(x));
      const cs = m.respAll[i]!.filter((x) => colSet.has(x));
      for (const r of rs) {
        rowTotal.set(r, (rowTotal.get(r) ?? 0) + 1);
        for (const c of cs) cell.set(`${r}:${c}`, (cell.get(`${r}:${c}`) ?? 0) + 1);
      }
      for (const c of cs) colTotal.set(c, (colTotal.get(c) ?? 0) + 1);
    }
    const shownRows = rows.filter((r) => (rowTotal.get(r) ?? 0) >= 10).sort((a, b) => (rowTotal.get(b) ?? 0) - (rowTotal.get(a) ?? 0)).slice(0, 16);
    const shownCols = cols.filter((c) => (colTotal.get(c) ?? 0) > 0).sort((a, b) => (colTotal.get(b) ?? 0) - (colTotal.get(a) ?? 0)).slice(0, 12);
    return { rowTotal, cell, rows: shownRows, cols: shownCols };
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const totalPop = m.totalPopulation;

  return (
    <div className="panels single">
      <Panel title={t.matrixDistrict} sub={t.matrixDistrictSub} wide>
        <div className="legend" aria-hidden="true">
          <span className="ix ix-0" /> <span className="ix ix-1" /> {t.legendBelow}
          <span className="ix ix-2" /> {t.legendAvg}
          <span className="ix ix-3" /> <span className="ix ix-4" /> {t.legendAbove}
        </div>
        <div className="tablewrap">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">{t.district}</th>
                {matrix.cols.map((c) => (
                  <th key={c} scope="col" className="colhead">
                    <span>{p.taxonomy[c]!.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.districts.map((dname, d) => {
                const pop = p.district_population[d] ?? 0;
                return (
                  <tr key={d} className={f.d === d ? 'selected' : undefined}>
                    <th scope="row">{dname}</th>
                    {matrix.cols.map((c) => {
                      const n = matrix.cell.get(`${d}:${c}`) ?? 0;
                      const national = (matrix.colTotal.get(c) ?? 0) / totalPop;
                      const ix = pop && national ? (n / pop / national) * 100 : 0;
                      return (
                        <td key={c} className={`ix ix-${indexBin(ix)}`}>
                          <button
                            type="button"
                            title={`${dname} · ${p.taxonomy[c]!.name}: ${nf.format(n)} ${t.points}`}
                            onClick={() => update({ d: dname, r: p.taxonomy[c]!.id, tab: 'regions' })}
                          >
                            {Math.round(ix)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={t.matrixCross} sub={t.matrixCrossSub} wide>
        <div className="tablewrap">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">{t.population}</th>
                {cross.cols.map((c) => (
                  <th key={c} scope="col" className="colhead">
                    <span>{p.taxonomy[c]!.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cross.rows.map((r) => {
                const total = cross.rowTotal.get(r) ?? 0;
                return (
                  <tr key={r}>
                    <th scope="row">
                      {p.taxonomy[r]!.name}
                      <span className="cell-note">{nf.format(total)}</span>
                    </th>
                    {cross.cols.map((c) => {
                      const n = cross.cell.get(`${r}:${c}`) ?? 0;
                      const share = total ? n / total : 0;
                      const bin = share === 0 ? 0 : share < 0.05 ? 1 : share < 0.15 ? 2 : share < 0.35 ? 3 : 4;
                      return (
                        <td key={c} className={`sq sq-${bin}`}>
                          <button
                            type="button"
                            title={`${p.taxonomy[r]!.name} · ${p.taxonomy[c]!.name}: ${nf.format(n)}`}
                            onClick={() => update({ s: p.taxonomy[r]!.id, r: p.taxonomy[c]!.id, tab: null })}
                          >
                            {Math.round(share * 100)}%
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- quality

function Quality({ m, f, t, lang }: Omit<ViewProps, 'update'>) {
  const nf = new Intl.NumberFormat(locale(lang));
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const p = m.p;

  const rows = useMemo(() => {
    const idx = select(m, f, 'd');
    const acc = new Map<number, { n: number; phone: number; exact: number; sit: number; kind: number }>();
    for (const i of idx) {
      const d = p.cards.national[i] ? -2 : m.cardDistrict[i]!;
      let a = acc.get(d);
      if (!a) acc.set(d, (a = { n: 0, phone: 0, exact: 0, sit: 0, kind: 0 }));
      a.n++;
      if (p.cards.phone[i]) a.phone++;
      if (p.cards.accurate[i]) a.exact++;
      if (p.cards.situations[i]!.length) a.sit++;
      if (p.kinds[p.orgs[p.cards.org[i]!]!.kind]) a.kind++;
    }
    const label = (d: number) => (d === -2 ? t.national : d === -1 ? t.outside : p.districts[d]!);
    return [...acc.entries()].map(([d, a]) => ({ d, label: label(d), ...a })).sort((x, y) => y.n - x.n);
  }, [m, f.d, f.sec, f.r, f.s, f.k, f.scope, f.town]);

  const matching = useMemo(() => {
    const out = { cbs: 0, nearest: 0, none: 0 };
    for (const c of p.cities) out[c.match]++;
    return out;
  }, [m]);

  const cell = (a: number, b: number, na = false) =>
    na ? (
      <td className="num muted">—</td>
    ) : (
      <td className="num">
        <span className="meter" aria-hidden="true">
          <span style={{ inlineSize: `${pct(a, b)}%` }} />
        </span>
        {pct(a, b)}%
      </td>
    );

  return (
    <div className="panels single">
      <Panel title={t.quality} sub={t.qualitySub} wide>
        <div className="tablewrap">
          <table className="dtable">
            <thead>
              <tr>
                <th scope="col">{t.district}</th>
                <th scope="col" className="num">{t.points}</th>
                <th scope="col" className="num">{t.qPhone}</th>
                <th scope="col" className="num">{t.qExact}</th>
                <th scope="col" className="num">{t.qSituation}</th>
                <th scope="col" className="num">{t.qKind}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.d}>
                  <th scope="row">{r.label}</th>
                  <td className="num">{nf.format(r.n)}</td>
                  {cell(r.phone, r.n)}
                  {cell(r.exact, r.n, r.d === -2)}
                  {cell(r.sit, r.n)}
                  {cell(r.kind, r.n)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t.matching} sub={t.matchingSub} wide>
        <div className="kpis compact">
          <Kpi label={t.mCbs} value={nf.format(matching.cbs)} />
          <Kpi label={t.mNearest} value={nf.format(matching.nearest)} />
          <Kpi label={t.mNone} value={nf.format(matching.none)} />
        </div>
      </Panel>
    </div>
  );
}
