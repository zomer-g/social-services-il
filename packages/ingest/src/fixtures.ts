import { cardId } from '@ssil/core';
import { query, transaction } from '@ssil/db';

/**
 * Development fixtures.
 *
 * Invented data, not a copy of anyone's corpus: the organizations here do not
 * exist. They are shaped like the real thing — Hebrew names with prefixes and
 * final letters, real city coordinates, nationwide hotlines alongside physical
 * branches, one service deliberately offered by three organizations, and one
 * branch with an address that never geocoded — so that search, collapsing,
 * distance ranking and the rejection path can all be exercised before real data
 * arrives.
 */

const SOURCE_SLUG = 'fixtures';

interface FixtureOrg {
  id: string;
  name: string;
  shortName?: string;
  kind: string;
  purpose?: string;
  phones: string[];
}

interface FixtureBranch {
  id: string;
  orgId: string;
  name?: string;
  address: string;
  city: string;
  /** Omitted for a branch whose address never resolved. */
  lat?: number;
  lon?: number;
  phones?: string[];
}

interface FixtureService {
  id: string;
  name: string;
  description: string;
  details?: string;
  orgIds: string[];
  branchIds: string[];
  responses: string[];
  situations: string[];
  phones?: string[];
  paymentRequired?: boolean;
}

const ORGS: FixtureOrg[] = [
  { id: '580000001', name: 'עמותת שולחן חם (דוגמה)', shortName: 'שולחן חם', kind: 'עמותה', purpose: 'ביטחון תזונתי למשפחות במצוקה', phones: ['03-5550101'] },
  { id: '580000002', name: 'אגודת מסע הביתה (דוגמה)', shortName: 'מסע הביתה', kind: 'עמותה', purpose: 'דיור מעבר לצעירים ולצעירות', phones: ['02-5550202'] },
  { id: '580000003', name: 'קו קשוב (דוגמה)', shortName: 'קו קשוב', kind: 'עמותה', purpose: 'תמיכה נפשית מיידית בטלפון', phones: ['1201'] },
  { id: '500000004', name: 'המחלקה לשירותים חברתיים - עיריית דוגמה', kind: 'רשות מקומית', purpose: 'שירותי רווחה עירוניים', phones: ['08-5550404'] },
  { id: '580000005', name: 'יד לשכנה (דוגמה)', shortName: 'יד לשכנה', kind: 'עמותה', purpose: 'סיוע חומרי לקשישים', phones: ['04-5550505'] },
  { id: '580000006', name: 'מרחב בטוח לנשים (דוגמה)', shortName: 'מרחב בטוח', kind: 'עמותה', purpose: 'מקלט וליווי לנשים נפגעות אלימות', phones: ['1202'] },
];

const BRANCHES: FixtureBranch[] = [
  { id: 'fx-b-tlv-1', orgId: '580000001', name: 'סניף תל אביב', address: 'לוינסקי 42, תל אביב יפו', city: 'תל אביב יפו', lat: 32.0565, lon: 34.7797 },
  { id: 'fx-b-jlm-1', orgId: '580000001', name: 'סניף ירושלים', address: 'יפו 97, ירושלים', city: 'ירושלים', lat: 31.7857, lon: 35.2093 },
  { id: 'fx-b-hfa-1', orgId: '580000005', name: 'סניף חיפה', address: 'הרצל 12, חיפה', city: 'חיפה', lat: 32.8156, lon: 34.9892 },
  { id: 'fx-b-jlm-2', orgId: '580000002', name: 'בית מעבר ירושלים', address: 'עמק רפאים 5, ירושלים', city: 'ירושלים', lat: 31.7619, lon: 35.2196 },
  { id: 'fx-b-bsh-1', orgId: '500000004', name: 'לשכת רווחה מרכז', address: 'רגר 20, באר שבע', city: 'באר שבע', lat: 31.2530, lon: 34.7915 },
  { id: 'fx-b-rml-1', orgId: '580000005', name: 'נקודת חלוקה רמלה', address: 'הרצל 55, רמלה', city: 'רמלה', lat: 31.9288, lon: 34.8667 },
  // Deliberately unresolvable: exercises the rejection path and the admin's
  // geocoding queue.
  { id: 'fx-b-nogeo', orgId: '580000002', name: 'סניף ללא מיקום מזוהה', address: 'ליד המתנ"ס הישן', city: 'לא ידוע' },
];

const SERVICES: FixtureService[] = [
  {
    id: 'fx-s-food-parcels',
    name: 'חלוקת סלי מזון שבועיים',
    description:
      'חלוקה שבועית של סלי מזון הכוללים מוצרי יסוד, ירקות ופירות טריים ומוצרי חלב, למשפחות שנקלעו למצוקה כלכלית. ההפניה נעשית דרך לשכת הרווחה או בפנייה ישירה לסניף.',
    details: 'החלוקה מתקיימת בימי שלישי בין 16:00 ל-19:00. יש להצטייד בתעודת זהות.',
    orgIds: ['580000001'],
    branchIds: ['fx-b-tlv-1', 'fx-b-jlm-1'],
    responses: ['human_services:food:food_delivery'],
    situations: ['human_situations:deprivation:low_income'],
  },
  {
    id: 'fx-s-hot-meal',
    name: 'ארוחה חמה יומית',
    description: 'בית תמחוי המגיש ארוחה חמה מדי יום, ללא תשלום וללא צורך בהפניה מוקדמת.',
    orgIds: ['580000001'],
    branchIds: ['fx-b-tlv-1'],
    responses: ['human_services:food:food_pantry'],
    situations: ['human_situations:deprivation:low_income', 'human_situations:housing:homeless'],
  },
  {
    id: 'fx-s-food-vouchers',
    name: 'תווי קנייה למזון',
    description: 'תווי קנייה חודשיים לרשתות המזון, למשפחות העומדות בקריטריונים של המחלקה לשירותים חברתיים.',
    orgIds: ['500000004', '580000005'],
    branchIds: ['fx-b-bsh-1', 'fx-b-rml-1'],
    responses: ['human_services:money:financial_assistance:help_pay_for_food'],
    situations: ['human_situations:deprivation:low_income'],
  },
  {
    id: 'fx-s-mental-hotline',
    name: 'קו חם לתמיכה נפשית',
    description: 'מענה טלפוני אנונימי מסביב לשעון למי שנמצא במצוקה נפשית, כולל ליווי ראשוני והפניה להמשך טיפול.',
    orgIds: ['580000003'],
    branchIds: [],
    responses: ['human_services:care:help_hotline'],
    situations: ['human_situations:mental_health'],
    phones: ['1201'],
  },
  {
    id: 'fx-s-transitional-housing',
    name: 'דיור מעבר לצעירים וצעירות',
    description:
      'דירות מעבר לצעירים וצעירות בגילאי 18 עד 26 שיצאו ממסגרות חוץ-ביתיות, הכוללות ליווי חברתי, סיוע בתעסוקה והכוונה לזכויות.',
    orgIds: ['580000002'],
    branchIds: ['fx-b-jlm-2', 'fx-b-nogeo'],
    responses: ['human_services:housing:short_term_housing:transit_flats'],
    situations: ['human_situations:age_group:young_adults', 'human_situations:housing:homeless'],
  },
  {
    id: 'fx-s-shelter',
    name: 'מקלט לנשים נפגעות אלימות',
    description: 'מקום מגורים מוגן לנשים ולילדיהן, עם ליווי סוציאלי ומשפטי. הקליטה מיידית ובכל שעה.',
    orgIds: ['580000006'],
    branchIds: [],
    responses: ['human_services:housing:short_term_housing:shelters_from_violence'],
    situations: ['human_situations:survivors:violence_survivors:domestic_violence_survivors'],
    phones: ['1202'],
  },
  {
    id: 'fx-s-senior-equipment',
    name: 'השאלת ציוד רפואי לקשישים',
    description: 'השאלה ללא תשלום של כיסאות גלגלים, הליכונים ומיטות סיעודיות, לתקופה של עד שישה חודשים.',
    orgIds: ['580000005'],
    branchIds: ['fx-b-hfa-1', 'fx-b-rml-1'],
    responses: ['human_services:health:medical_supplies'],
    situations: ['human_situations:age_group:seniors'],
  },
  {
    id: 'fx-s-rights',
    name: 'מיצוי זכויות מול המוסד לביטוח לאומי',
    description:
      'ליווי אישי במימוש זכויות: בדיקת זכאות לקצבאות, מילוי טפסים, הכנה לוועדות רפואיות והגשת ערר.',
    orgIds: ['500000004'],
    branchIds: ['fx-b-bsh-1'],
    responses: ['human_services:legal:advocacy_legal_aid:understand_government_programs'],
    situations: ['human_situations:deprivation:low_income', 'human_situations:age_group:seniors'],
  },
];

/** Synonyms the taxonomy does not ship, exercising synonym-driven recall. */
const SYNONYMS: { nodeId: string; lang: string; terms: string[] }[] = [
  { nodeId: 'human_services:food:food_delivery', lang: 'he', terms: ['סל מזון', 'חבילת מזון', 'סלי מזון'] },
  { nodeId: 'human_services:food:food_pantry', lang: 'he', terms: ['בית תמחוי', 'ארוחה חמה', 'הסעדה'] },
  { nodeId: 'human_services:money:financial_assistance:help_pay_for_food', lang: 'he', terms: ['תווי מזון', 'תלושי מזון', 'תווי קנייה'] },
  { nodeId: 'human_services:money:financial_assistance', lang: 'he', terms: ['קצבה', 'סיוע כספי', 'מענק'] },
  { nodeId: 'human_services:care:help_hotline', lang: 'he', terms: ['קו חם', 'קו סיוע', 'מוקד טלפוני'] },
  { nodeId: 'human_services:housing:short_term_housing:transit_flats', lang: 'he', terms: ['דירת מעבר', 'דיור מעבר'] },
  { nodeId: 'human_situations:deprivation:low_income', lang: 'he', terms: ['עוני', 'מצוקה כלכלית', 'הכנסה נמוכה'] },
  { nodeId: 'human_situations:housing:homeless', lang: 'he', terms: ['חסרי בית', 'דרי רחוב'] },
];

export interface FixtureResult {
  organizations: number;
  branches: number;
  services: number;
  skippedTags: string[];
}

export async function loadFixtures(): Promise<FixtureResult> {
  const skippedTags: string[] = [];

  await transaction(async (client) => {
    const { rows: srcRows } = await client.query<{ id: string }>(
      `INSERT INTO sources (slug, name, kind, trust_level, enabled)
       VALUES ($1, 'Development fixtures', 'manual', 100, false)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [SOURCE_SLUG],
    );
    const sourceId = srcRows[0]?.id;

    for (const o of ORGS) {
      await client.query(
        `INSERT INTO organizations (id, slug, name, short_name, kind, purpose, phone_numbers, status, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', $8)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, short_name = EXCLUDED.short_name, kind = EXCLUDED.kind,
           purpose = EXCLUDED.purpose, phone_numbers = EXCLUDED.phone_numbers,
           status = 'published', updated_at = now()`,
        [o.id, `fx-${o.id}`, o.name, o.shortName ?? null, o.kind, o.purpose ?? null, o.phones, sourceId],
      );
    }

    for (const b of BRANCHES) {
      const locationId = `fx-loc-${b.id}`;
      await client.query(
        `INSERT INTO locations (id, raw_address, provider, accuracy, resolved_lat, resolved_lon,
                                resolved_address, resolved_city)
         VALUES ($1, $2, 'fixture', $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           accuracy = EXCLUDED.accuracy,
           resolved_lat = EXCLUDED.resolved_lat, resolved_lon = EXCLUDED.resolved_lon,
           resolved_address = EXCLUDED.resolved_address, resolved_city = EXCLUDED.resolved_city`,
        [
          locationId,
          b.address,
          b.lat === undefined ? 'unknown' : 'building',
          b.lat ?? null,
          b.lon ?? null,
          b.lat === undefined ? null : b.address,
          b.lat === undefined ? null : b.city,
        ],
      );

      await client.query(
        `INSERT INTO branches (id, organization_id, location_id, name, address, phone_numbers, status, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'published', $7)
         ON CONFLICT (id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id, location_id = EXCLUDED.location_id,
           name = EXCLUDED.name, address = EXCLUDED.address,
           phone_numbers = EXCLUDED.phone_numbers, status = 'published', updated_at = now()`,
        [b.id, b.orgId, locationId, b.name ?? null, b.address, b.phones ?? [], sourceId],
      );
    }

    for (const s of SERVICES) {
      await client.query(
        `INSERT INTO services (id, name, description, details, payment_required, phone_numbers,
                               data_sources, status, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, ARRAY['Development fixture — not real service data'], 'published', $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, details = EXCLUDED.details,
           payment_required = EXCLUDED.payment_required, phone_numbers = EXCLUDED.phone_numbers,
           status = 'published', updated_at = now()`,
        [s.id, s.name, s.description, s.details ?? null, s.paymentRequired ?? false, s.phones ?? [], sourceId],
      );

      await client.query('DELETE FROM service_organizations WHERE service_id = $1', [s.id]);
      for (const orgId of s.orgIds) {
        await client.query(
          'INSERT INTO service_organizations (service_id, organization_id) VALUES ($1, $2)',
          [s.id, orgId],
        );
      }

      await client.query('DELETE FROM service_branches WHERE service_id = $1', [s.id]);
      for (const branchId of s.branchIds) {
        await client.query('INSERT INTO service_branches (service_id, branch_id) VALUES ($1, $2)', [
          s.id,
          branchId,
        ]);
      }

      await client.query(
        `DELETE FROM entity_taxonomy WHERE entity_type = 'service' AND entity_id = $1`,
        [s.id],
      );
      for (const [axis, ids] of [
        ['response', s.responses],
        ['situation', s.situations],
      ] as const) {
        for (const nodeId of ids) {
          // A fixture that names a node the taxonomy does not have is reported
          // rather than silently dropped: it means the fixture is wrong.
          const { rowCount } = await client.query(
            `INSERT INTO entity_taxonomy (entity_type, entity_id, node_id, axis, origin, actor)
             SELECT 'service', $1, $2, $3::ssil_axis, 'manual', 'fixtures'
             WHERE EXISTS (SELECT 1 FROM taxonomy_nodes WHERE id = $2)
             ON CONFLICT DO NOTHING`,
            [s.id, nodeId, axis],
          );
          if (!rowCount) skippedTags.push(`${s.id} → ${nodeId}`);
        }
      }
    }

    for (const syn of SYNONYMS) {
      for (const term of syn.terms) {
        await client.query(
          `INSERT INTO taxonomy_synonyms (node_id, lang, term)
           SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM taxonomy_nodes WHERE id = $1)
           ON CONFLICT DO NOTHING`,
          [syn.nodeId, syn.lang, term],
        );
      }
    }
  });

  return {
    organizations: ORGS.length,
    branches: BRANCHES.length,
    services: SERVICES.length,
    skippedTags,
  };
}

/** Removes everything the fixtures created, leaving real data untouched. */
export async function clearFixtures(): Promise<void> {
  await query(
    `DELETE FROM services WHERE source_id = (SELECT id FROM sources WHERE slug = $1)`,
    [SOURCE_SLUG],
  );
  await query(
    `DELETE FROM branches WHERE source_id = (SELECT id FROM sources WHERE slug = $1)`,
    [SOURCE_SLUG],
  );
  await query(
    `DELETE FROM organizations WHERE source_id = (SELECT id FROM sources WHERE slug = $1)`,
    [SOURCE_SLUG],
  );
}

/** Card ids the fixtures will produce, useful for asserting in tests. */
export function fixtureCardIds(): string[] {
  return SERVICES.flatMap((s) =>
    s.branchIds.length ? s.branchIds.map((b) => cardId(s.id, b)) : [cardId(s.id, null)],
  );
}
