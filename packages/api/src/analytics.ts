import { LOCALITIES, LOCALITIES_SOURCE, type Sector } from './data/localities.js';

/**
 * The dataset behind the public dashboard.
 *
 * The dashboard slices the whole corpus every time a filter changes, and the
 * questions people ask of it are open-ended — "food services per resident in the
 * north, run by local authorities" — so the browser gets every card once, in a
 * compact columnar form, rather than asking the server one aggregate at a time.
 * Strings appear once in a dictionary and cards refer to them by index, which
 * keeps sixteen thousand cards to a few hundred kilobytes over the wire.
 *
 * Two things are added that the corpus does not hold: each town's district and
 * its population, from the CBS localities file, matched by name. A card only
 * knows its city as a string, so the match is by normalised spelling, and a
 * town whose spelling still does not match borrows the district of the nearest
 * town that did — but never a population, which would be invented.
 */

export interface CardRow {
  service_id: string;
  organization_id: string;
  organization_name: string;
  organization_kind: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  national_service: boolean;
  location_accurate: boolean;
  phone_numbers: string[] | null;
  response_ids: string[] | null;
  situation_ids: string[] | null;
}

export interface TaxonomyRow {
  id: string;
  axis: 'response' | 'situation';
  parent_id: string | null;
  name: string | null;
}

export interface AnalyticsCity {
  name: string;
  district: number;
  subdistrict: string | null;
  population: number | null;
  sector: Sector | null;
  /** How the town was placed: its own CBS row, or the district of its nearest neighbour. */
  match: 'cbs' | 'nearest' | 'none';
  lat: number | null;
  lon: number | null;
}

export interface AnalyticsPayload {
  generated_at: string;
  sources: { localities: typeof LOCALITIES_SOURCE };
  districts: string[];
  /** Everyone in each district per the CBS, including towns with no services here. */
  district_population: number[];
  /** The same, per CBS sector. */
  sector_population: Record<Sector, number>;
  /**
   * Towns the CBS counts people in and the corpus has no service in at all.
   * [name, district, population, sector]. Only towns of 2,000 or more: below
   * that, services are usually run by the regional council from elsewhere.
   */
  uncovered: [name: string, district: number, population: number, sector: Sector | null][];
  kinds: string[];
  taxonomy: { id: string; axis: 'response' | 'situation'; parent: number; name: string }[];
  orgs: { name: string; kind: number }[];
  cities: AnalyticsCity[];
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

/** Spelling-insensitive key: niqqud, punctuation, doubled yod/vav and final letters all fold away. */
export function placeKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^א-תa-z0-9]/gi, '')
    .replace(/יי/g, 'י')
    .replace(/וו/g, 'ו')
    .replace(/ך/g, 'כ')
    .replace(/ם/g, 'מ')
    .replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ')
    .replace(/ץ/g, 'צ')
    .toLowerCase();
}

/**
 * Spellings in the corpus that no normalisation reaches: a transliteration
 * convention (ע' against ג), a dropped suffix, a merged municipality. Each maps
 * to the CBS name. Found by listing the corpus cities that did not match, most
 * services first.
 */
const ALIASES: Record<string, string> = {
  "באקה אל-ע'רביה": 'באקה אל-גרביה',
  'יוקנעם עילית': 'יקנעם עילית',
  'יוקנעם': 'יקנעם (מושבה)',
  "מע'אר": 'מגאר',
  'פקיעין': 'פקיעין (בוקייעה)',
  "ג'וליס": "ג'ולס",
  'איכסאל': 'אכסאל',
  'כוכב יאיר צור יגאל': 'כוכב יאיר',
  'כיסרא סומיע': 'כסרא-סמיע',
  'שגב שלום שוקייב א סאלם': 'שגב-שלום',
  'בית אריה': 'בית אריה-עופרים',
  'עיספיא': 'עספיא',
  "מג'דל א-שמס": "מג'דל שמס",
  "ג'יש": "ג'ש (גוש חלב)",
  'לוחמי הגטאות': 'לוחמי הגיטאות',
  'שיבלי': 'שבלי - אום אל-גנם',
  'כנרת': 'כנרת (מושבה)',
  'כינרת': 'כנרת (מושבה)',
  'כינרת-קבוצה': 'כנרת (קבוצה)',
  'בן שמן': 'בן שמן (מושב)',
  'כפר הנוער בן שמן': 'בן שמן (כפר נוער)',
};

const localityByKey = new Map(LOCALITIES.map((l) => [placeKey(l[0]), l] as const));

function findLocality(city: string) {
  return localityByKey.get(placeKey(ALIASES[city] ?? city)) ?? null;
}

/** Straight-line distance in km; accurate enough to pick a neighbour inside Israel. */
function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 111;
  const dLon = (aLon - bLon) * 111 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** A neighbour further than this is in a different place, not a different spelling of this one. */
const NEAREST_MAX_KM = 12;

const round3 = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);

export function buildAnalytics(cards: CardRow[], taxonomy: TaxonomyRow[], now = new Date()): AnalyticsPayload {
  const intern = <T>(map: Map<string, number>, list: T[], key: string, make: () => T): number => {
    let i = map.get(key);
    if (i === undefined) {
      i = list.length;
      map.set(key, i);
      list.push(make());
    }
    return i;
  };

  // Taxonomy: every active node, plus any id a card carries that the tree no
  // longer has, so no card silently loses a category.
  const taxIndex = new Map<string, number>();
  const tax: AnalyticsPayload['taxonomy'] = [];
  for (const n of taxonomy) intern(taxIndex, tax, n.id, () => ({ id: n.id, axis: n.axis, parent: -1, name: n.name ?? n.id }));
  for (const n of taxonomy) {
    const self = taxIndex.get(n.id)!;
    tax[self]!.parent = n.parent_id ? (taxIndex.get(n.parent_id) ?? -1) : -1;
  }
  const taxId = (id: string, axis: 'response' | 'situation') =>
    intern(taxIndex, tax, id, () => ({ id, axis, parent: -1, name: id.split(':').pop()!.replace(/_/g, ' ') }));

  const districts: string[] = [];
  const districtIndex = new Map<string, number>();
  const districtPopulation: number[] = [];
  const sectorPopulation: Record<Sector, number> = { jewish: 0, arab: 0, bedouin: 0, mixed: 0 };
  for (const [, district, , population, sector] of LOCALITIES) {
    if (!district) continue;
    const d = intern(districtIndex, districts, district, () => district);
    districtPopulation[d] = (districtPopulation[d] ?? 0) + population;
    if (sector) sectorPopulation[sector] += population;
  }
  const kinds: string[] = [];
  const kindIndex = new Map<string, number>();
  const orgs: AnalyticsPayload['orgs'] = [];
  const orgIndex = new Map<string, number>();
  const serviceIndex = new Map<string, number>();
  const services: null[] = [];
  const cities: AnalyticsCity[] = [];
  const cityIndex = new Map<string, number>();
  const cityPoints: { lat: number; lon: number; n: number }[] = [];

  const out: AnalyticsPayload['cards'] = {
    service: [], org: [], city: [], national: [], accurate: [], phone: [],
    lat: [], lon: [], responses: [], situations: [],
  };

  for (const c of cards) {
    const kind = intern(kindIndex, kinds, c.organization_kind ?? '', () => c.organization_kind ?? '');
    out.org.push(intern(orgIndex, orgs, c.organization_id, () => ({ name: c.organization_name, kind })));
    out.service.push(intern(serviceIndex, services, c.service_id, () => null));

    let city = -1;
    if (c.city && !c.national_service) {
      const name = c.city;
      city = intern(cityIndex, cities, name, (): AnalyticsCity => {
        const loc = findLocality(name);
        cityPoints.push({ lat: 0, lon: 0, n: 0 });
        return {
          name,
          district: loc ? intern(districtIndex, districts, loc[1], () => loc[1]) : -1,
          subdistrict: loc?.[2] || null,
          population: loc?.[3] ?? null,
          sector: loc?.[4] ?? null,
          match: loc ? 'cbs' : 'none',
          lat: null,
          lon: null,
        };
      });
      if (c.lat != null && c.lon != null) {
        const p = cityPoints[city]!;
        p.lat += c.lat;
        p.lon += c.lon;
        p.n += 1;
      }
    }
    out.city.push(city);
    out.national.push(c.national_service ? 1 : 0);
    out.accurate.push(c.location_accurate ? 1 : 0);
    out.phone.push((c.phone_numbers ?? []).length > 0 ? 1 : 0);
    out.lat.push(round3(c.lat));
    out.lon.push(round3(c.lon));
    out.responses.push((c.response_ids ?? []).map((id) => taxId(id, 'response')));
    out.situations.push((c.situation_ids ?? []).map((id) => taxId(id, 'situation')));
  }

  // Each town's centre is the mean of its cards, which is what the dashboard's
  // map and the nearest-neighbour fallback both need.
  cities.forEach((city, i) => {
    const p = cityPoints[i]!;
    if (p.n > 0) {
      city.lat = round3(p.lat / p.n);
      city.lon = round3(p.lon / p.n);
    }
  });
  const placed = cities.filter((c) => c.match === 'cbs' && c.lat != null);
  for (const city of cities) {
    if (city.match !== 'none' || city.lat == null) continue;
    let best: AnalyticsCity | null = null;
    let bestKm = NEAREST_MAX_KM;
    for (const other of placed) {
      const d = km(city.lat, city.lon!, other.lat!, other.lon!);
      if (d < bestKm) {
        bestKm = d;
        best = other;
      }
    }
    if (best) {
      city.district = best.district;
      city.subdistrict = best.subdistrict;
      city.match = 'nearest';
    }
  }

  const served = new Set(cities.filter((c) => c.match === 'cbs').map((c) => placeKey(ALIASES[c.name] ?? c.name)));
  const uncovered: AnalyticsPayload['uncovered'] = LOCALITIES.filter(
    ([name, district, , population]) => population >= 2000 && district && !served.has(placeKey(name)),
  ).map(([name, district, , population, sector]) => [name, districtIndex.get(district)!, population, sector]);

  return {
    generated_at: now.toISOString(),
    sources: { localities: LOCALITIES_SOURCE },
    districts,
    district_population: districtPopulation,
    sector_population: sectorPopulation,
    uncovered,
    kinds,
    taxonomy: tax,
    orgs,
    cities,
    cards: out,
  };
}
