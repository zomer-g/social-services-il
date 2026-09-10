import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { matchService, query, transaction } from '@ssil/db';
import { contentHash } from '@ssil/core';
import { AUTO_PUBLISH_TRUST_THRESHOLD } from '@ssil/ingest';
import { requireScope } from '../apikeys.js';

/**
 * The write API.
 *
 * The thing this whole project exists to add: today an organization that wants
 * its services listed must type them into a third-party nonprofit registry and
 * wait to be scraped, or send an email. Here it can push them.
 *
 * Three properties make that safe to offer.
 *
 * Identity is (source, external_id), not our ids. A caller pushes the same rows
 * from its own system every night and gets the same records, so re-sending is
 * free and nothing is duplicated by an interrupted run.
 *
 * dry_run returns the exact diff without writing. Nobody should have to test an
 * integration by mutating a live directory of shelters and food banks.
 *
 * Errors are per item. A batch of two hundred services with one bad phone number
 * writes the other hundred and ninety-nine and says precisely which one failed —
 * all-or-nothing would mean one typo blocks a whole night's update.
 */
export const ingestRouter: Router = Router();

const UrlSchema = z.object({ href: z.string().url(), title: z.string().optional() });

const OrganizationSchema = z.object({
  // The Israeli registration number where there is one. Supplying it is what
  // lets a record from this source meet the same organization from another.
  id: z.string().max(100).optional(),
  external_id: z.string().max(200).optional(),
  name: z.string().min(1).max(400),
  short_name: z.string().max(200).optional(),
  kind: z.string().max(100).optional(),
  purpose: z.string().max(4000).optional(),
  description: z.string().max(8000).optional(),
  phone_numbers: z.array(z.string().max(50)).max(10).optional(),
  email_address: z.string().email().optional(),
  urls: z.array(UrlSchema).max(10).optional(),
});

const BranchSchema = z.object({
  external_id: z.string().min(1).max(200),
  name: z.string().max(300).optional(),
  operating_unit: z.string().max(300).optional(),
  description: z.string().max(4000).optional(),
  address: z.string().max(500).optional(),
  address_details: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  phone_numbers: z.array(z.string().max(50)).max(10).optional(),
  email_address: z.string().email().optional(),
  urls: z.array(UrlSchema).max(10).optional(),
  source_updated_at: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('When the source last changed this branch. Distinct from when we received it.'),
  national_service: z.boolean().optional().describe('Delivered anywhere in the country; this branch has no point on the map.'),
  location_accuracy: z
    .enum(['rooftop', 'building', 'street', 'locality', 'region', 'approximate', 'unknown'])
    .optional()
    .describe('How precise the coordinate is. Anything below street level is shown with a warning.'),
  // A branch belongs to an organization, and for a service delivered through
  // several bodies that is not the same one throughout: a municipal programme
  // run by four different nonprofits has four providers, and saying so is the
  // difference between a usable phone number and a wrong one.
  organization: z
    .lazy(() => OrganizationSchema)
    .optional()
    .describe('The body running this branch, when it differs from the service-level organization.'),
});


const ServiceSchema = z.object({
  external_id: z.string().min(1).max(200).describe('Your id for this service. Re-sending it updates the same record.'),
  name: z.string().min(2).max(400),
  description: z.string().max(8000).optional(),
  details: z.string().max(8000).optional(),
  payment_required: z
    .boolean()
    .nullable()
    .optional()
    .describe('true = charges, false = stated free. Omit it when the source did not say; it is not assumed free.'),
  payment_details: z.string().max(2000).optional(),
  phone_numbers: z.array(z.string().max(50)).max(10).optional(),
  email_address: z.string().email().optional(),
  urls: z.array(UrlSchema).max(10).optional(),
  implements: z.string().max(500).optional(),
  /**
   * When the source last changed this record. Distinct from when we received
   * it, and the only honest answer to "how old is this" — which matters because
   * assistants are told to relay it before someone acts on a phone number.
   */
  source_updated_at: z.string().datetime({ offset: true }).optional(),
  responses: z.array(z.string()).min(1).describe('Response taxonomy ids. At least one, or the service cannot be found.'),
  situations: z.array(z.string()).optional(),
  organization: OrganizationSchema,
  branches: z.array(BranchSchema).max(5000).optional(),
  national_service: z.boolean().optional().describe('True for a service with no physical location, available anywhere.'),
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

const PayloadSchema = z.object({
  dry_run: z.boolean().optional(),
  services: z.array(ServiceSchema).min(1).max(500),
});

type ServiceInput = z.infer<typeof ServiceSchema>;

interface ItemResult {
  external_id: string;
  status: 'created' | 'updated' | 'unchanged' | 'rejected' | 'queued_for_review';
  service_id?: string;
  changes?: string[];
  /** Things that were dropped but did not stop the record being written. */
  warnings?: string[];
  error?: string;
}

ingestRouter.post('/services', requireScope('ingest:write'), (req: Request, res: Response) => {
  void handleIngest(req, res).catch((err: Error) => {
    console.error('[error] ingest:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

async function handleIngest(req: Request, res: Response): Promise<void> {
  const key = req.apiKey!;
  if (!key.sourceId || !key.sourceSlug) {
    res.status(403).json({
      error: 'key_has_no_source',
      message: 'This key is not attached to a source, so its data could not be attributed. Ask an administrator to attach one.',
    });
    return;
  }

  const parsed = PayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_payload',
      // The path is what makes a validation error actionable in a 500-item batch.
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  const { dry_run: dryRun = false, services } = parsed.data;
  const autoPublish = key.trustLevel >= AUTO_PUBLISH_TRUST_THRESHOLD;

  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO ingest_runs (source_id, trigger, status)
     VALUES ($1, $2, 'running') RETURNING id`,
    [key.sourceId, dryRun ? 'dry_run' : 'push'],
  );
  const runId = runRows[0]!.id;

  const results: ItemResult[] = [];
  for (const service of services) {
    try {
      results.push(await upsertService(service, { ...key, runId, dryRun, autoPublish }));
    } catch (err) {
      results.push({
        external_id: service.external_id,
        status: 'rejected',
        error: (err as Error).message,
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  await query(
    `UPDATE ingest_runs SET status = 'success', finished_at = now(), stats = $2 WHERE id = $1`,
    [runId, JSON.stringify({ ...counts, dry_run: dryRun })],
  );

  // Cards are rebuilt on publish, not per write: a batch of 500 services should
  // cost one rebuild, and a dry run should cost none.
  if (!dryRun && (counts['created'] || counts['updated'])) {
    await query(
      `INSERT INTO system_state (key, value) VALUES ('cards_need_rebuild', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`ingest run ${runId}`],
    );
  }

  res.status(dryRun ? 200 : 202).json({
    run_id: runId,
    dry_run: dryRun,
    // Saying this out loud matters: a caller that expected to publish and is
    // being queued should find out from the response, not by wondering why the
    // site does not show its data.
    published_immediately: autoPublish,
    summary: counts,
    results,
  });
}

interface Ctx {
  sourceId: string | null;
  sourceSlug: string | null;
  runId: string;
  dryRun: boolean;
  autoPublish: boolean;
  name: string;
}

async function upsertService(input: ServiceInput, ctx: Ctx): Promise<ItemResult> {
  const sourceSlug = ctx.sourceSlug!;
  const serviceId = `${sourceSlug}:${input.external_id}`;
  const orgId = input.organization.id ?? `${sourceSlug}:org:${input.organization.external_id ?? input.organization.name}`;

  // Unknown taxonomy ids are dropped and reported, not silently accepted and
  // not fatal. A real corpus carries the occasional corrupt tag, and losing a
  // whole service over one of them helps nobody — but a tag that vanishes
  // without a word is how a service quietly becomes unreachable, so every drop
  // comes back in `warnings`.
  const allTags = [...input.responses, ...(input.situations ?? [])];
  const { rows: known } = await query<{ id: string }>(
    'SELECT id FROM taxonomy_nodes WHERE id = ANY($1::text[]) AND active',
    [allTags],
  );
  const knownIds = new Set(known.map((k) => k.id));
  const warnings: string[] = [];
  const unknown = allTags.filter((t) => !knownIds.has(t));
  if (unknown.length) {
    warnings.push(`Unknown taxonomy ids dropped: ${unknown.join(', ')}`);
  }

  const responses = input.responses.filter((t) => knownIds.has(t));
  const situations = (input.situations ?? []).filter((t) => knownIds.has(t));

  // With no response left there is no route through the site to this service,
  // so it would exist and be unreachable. That is worth failing for.
  if (responses.length === 0) {
    throw new Error(
      `No valid response tags. Given: ${input.responses.join(', ') || '(none)'}. ` +
        'Use GET /api/v1/taxonomy to list valid ids.',
    );
  }

  const existing = await query<{ id: string; name: string; description: string | null; status: string }>(
    'SELECT id, name, description, status FROM services WHERE id = $1',
    [serviceId],
  );
  const before = existing.rows[0];

  const changes: string[] = [];
  if (!before) changes.push('created');
  else {
    if (before.name !== input.name) changes.push('name');
    if ((before.description ?? null) !== (input.description ?? null)) changes.push('description');
  }

  const status = input.status ?? (ctx.autoPublish ? 'published' : 'draft');

  if (ctx.dryRun) {
    return {
      external_id: input.external_id,
      status: before ? (changes.length ? 'updated' : 'unchanged') : 'created',
      service_id: serviceId,
      changes,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  await transaction(async (client) => {
    // The payload is kept verbatim before anything is derived from it, so a
    // mapping mistake can be diagnosed and replayed later.
    await client.query(
      `INSERT INTO raw_records (source_id, ingest_run_id, entity_type, external_id, payload, content_hash)
       VALUES ($1, $2, 'service', $3, $4, $5)`,
      [ctx.sourceId, ctx.runId, input.external_id, JSON.stringify(input), contentHash(input)],
    );

    const upsertOrganization = async (org: z.infer<typeof OrganizationSchema>): Promise<string> => {
      const id = org.id ?? `${sourceSlug}:org:${org.external_id ?? org.name}`;
      await client.query(
        `INSERT INTO organizations (id, slug, name, short_name, kind, purpose, description,
                                    urls, phone_numbers, email_address, status, source_id, external_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, short_name = EXCLUDED.short_name, kind = EXCLUDED.kind,
           purpose = EXCLUDED.purpose, description = EXCLUDED.description,
           urls = EXCLUDED.urls, phone_numbers = EXCLUDED.phone_numbers,
           email_address = EXCLUDED.email_address, status = EXCLUDED.status,
           external_ids = organizations.external_ids || EXCLUDED.external_ids,
           updated_at = now()`,
        [
          id,
          id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase(),
          org.name,
          org.short_name ?? null,
          org.kind ?? null,
          org.purpose ?? null,
          org.description ?? null,
          JSON.stringify(org.urls ?? []),
          org.phone_numbers ?? [],
          org.email_address ?? null,
          status,
          ctx.sourceId,
          JSON.stringify(org.external_id ? { [sourceSlug]: org.external_id } : {}),
        ],
      );
      return id;
    };

    await upsertOrganization(input.organization);

    await client.query(
      `INSERT INTO services (id, name, description, details, payment_required, payment_details,
                             urls, phone_numbers, email_address, implements, data_sources,
                             status, source_id, external_ids, source_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, details = EXCLUDED.details,
         payment_required = EXCLUDED.payment_required, payment_details = EXCLUDED.payment_details,
         urls = EXCLUDED.urls, phone_numbers = EXCLUDED.phone_numbers,
         email_address = EXCLUDED.email_address, implements = EXCLUDED.implements,
         status = EXCLUDED.status,
         source_updated_at = COALESCE(EXCLUDED.source_updated_at, services.source_updated_at),
         updated_at = now()`,
      [
        serviceId,
        input.name,
        input.description ?? null,
        input.details ?? null,
        input.payment_required ?? null,
        input.payment_details ?? null,
        JSON.stringify(input.urls ?? []),
        input.phone_numbers ?? [],
        input.email_address ?? null,
        input.implements ?? null,
        [`Submitted via API by ${ctx.name}`],
        status,
        ctx.sourceId,
        JSON.stringify({ [sourceSlug]: input.external_id }),
        input.source_updated_at ?? null,
      ],
    );

    await client.query(
      `INSERT INTO service_organizations (service_id, organization_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [serviceId, orgId],
    );

    // Tags from a source replace that source's previous tags, but never touch a
    // manual one: an editor's correction must survive the next nightly push.
    await client.query(
      `DELETE FROM entity_taxonomy
        WHERE entity_type = 'service' AND entity_id = $1 AND origin = 'source'`,
      [serviceId],
    );
    for (const [axis, ids] of [
      ['response', responses],
      ['situation', situations],
    ] as const) {
      for (const nodeId of ids) {
        await client.query(
          `INSERT INTO entity_taxonomy (entity_type, entity_id, node_id, axis, origin, actor)
           VALUES ('service', $1, $2, $3::ssil_axis, 'source', $4)
           ON CONFLICT (entity_type, entity_id, node_id) DO NOTHING`,
          [serviceId, nodeId, axis, sourceSlug],
        );
      }
    }

    const branches = input.branches ?? [];
    for (const branch of branches) {
      const branchId = `${sourceSlug}:${branch.external_id}`;
      const locationId = `${sourceSlug}:loc:${branch.external_id}`;

      await client.query(
        `INSERT INTO locations (id, raw_address, provider, accuracy, resolved_lat, resolved_lon,
                                resolved_address, resolved_city, national_service)
         VALUES ($1, $2, $3, $4::ssil_accuracy, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           raw_address = EXCLUDED.raw_address,
           national_service = EXCLUDED.national_service,
           -- A coordinate supplied by the source only overwrites the geocoder's
           -- answer, never a correction someone made by hand.
           resolved_lat = EXCLUDED.resolved_lat, resolved_lon = EXCLUDED.resolved_lon,
           accuracy = EXCLUDED.accuracy,
           resolved_address = EXCLUDED.resolved_address, resolved_city = EXCLUDED.resolved_city`,
        [
          locationId,
          branch.address ?? '',
          `api:${sourceSlug}`,
          branch.location_accuracy ?? (branch.lat != null ? 'building' : 'unknown'),
          branch.lat ?? null,
          branch.lon ?? null,
          branch.address ?? null,
          branch.city ?? null,
          branch.national_service ?? false,
        ],
      );

      // A branch names its own provider where it has one; otherwise it belongs
      // to the organization that offers the service.
      const branchOrgId = branch.organization ? await upsertOrganization(branch.organization) : orgId;
      if (branchOrgId !== orgId) {
        await client.query(
          `INSERT INTO service_organizations (service_id, organization_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [serviceId, branchOrgId],
        );
      }

      await client.query(
        `INSERT INTO branches (id, organization_id, location_id, name, operating_unit, description,
                               address, address_details, urls, phone_numbers, email_address,
                               status, source_id, external_ids, source_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id, location_id = EXCLUDED.location_id,
           name = EXCLUDED.name, operating_unit = EXCLUDED.operating_unit,
           description = EXCLUDED.description, address = EXCLUDED.address,
           address_details = EXCLUDED.address_details, urls = EXCLUDED.urls,
           phone_numbers = EXCLUDED.phone_numbers, email_address = EXCLUDED.email_address,
           status = EXCLUDED.status, updated_at = now(),
           source_updated_at = COALESCE(EXCLUDED.source_updated_at, branches.source_updated_at)`,
        [
          branchId,
          branchOrgId,
          locationId,
          branch.name ?? null,
          branch.operating_unit ?? null,
          branch.description ?? null,
          branch.address ?? null,
          branch.address_details ?? null,
          JSON.stringify(branch.urls ?? []),
          branch.phone_numbers ?? [],
          branch.email_address ?? null,
          status,
          ctx.sourceId,
          JSON.stringify({ [sourceSlug]: branch.external_id }),
          branch.source_updated_at ?? null,
        ],
      );

      await client.query(
        `INSERT INTO service_branches (service_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [serviceId, branchId],
      );
    }

    // A branch the source has stopped sending is detached rather than deleted,
    // so history and any manual work on it survive.
    if (branches.length) {
      await client.query(
        `DELETE FROM service_branches
          WHERE service_id = $1
            AND branch_id LIKE $2
            AND branch_id <> ALL($3::text[])`,
        [serviceId, `${sourceSlug}:%`, branches.map((b) => `${sourceSlug}:${b.external_id}`)],
      );
    }

    await client.query(
      `INSERT INTO change_log (entity_type, entity_id, action, changed, actor, source_id)
       VALUES ('service', $1, $2, $3, $4, $5)`,
      [
        serviceId,
        before ? 'update' : 'create',
        JSON.stringify({ fields: changes }),
        `api_key:${ctx.name}`,
        ctx.sourceId,
      ],
    );

    if (!ctx.autoPublish) {
      await client.query(
        `INSERT INTO moderation_queue (kind, entity_type, entity_id, payload, source_id, submitted_by)
         VALUES ($1, 'service', $2, $3, $4, $5)`,
        [
          before ? 'update_service' : 'new_service',
          serviceId,
          JSON.stringify(input),
          ctx.sourceId,
          `api_key:${ctx.name}`,
        ],
      );
    }
  });

  return {
    external_id: input.external_id,
    status: ctx.autoPublish ? (before ? (changes.length ? 'updated' : 'unchanged') : 'created') : 'queued_for_review',
    service_id: serviceId,
    changes,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * "Do you already have this?"
 *
 * The call a caller should make before the one above. Sources overlap: a service
 * a ministry funds, a municipality contracts for and a nonprofit delivers is one
 * service, and three sources describing it independently is how a directory
 * fills up with the same shelter three times.
 *
 * It takes the service objects you were about to push — the same shape, so
 * nothing has to be rewritten — and answers for each one whether it already
 * exists, with the score broken into its parts. `link` means confident enough to
 * record without a person; `review` means a person should look; `new` means push
 * it. Nothing is written either way.
 */
const MatchCandidateSchema = z.object({
  external_id: z.string().max(200).optional(),
  name: z.string().min(2).max(400),
  alternate_names: z
    .array(z.string().max(400))
    .max(5)
    .optional()
    .describe('Other names the same offering goes by — the programme name, the provider\'s own name for it.'),
  phone_numbers: z.array(z.string().max(50)).max(10).optional(),
  urls: z.array(z.union([UrlSchema, z.string()])).max(10).optional(),
  responses: z.array(z.string()).max(30).optional(),
  situations: z.array(z.string()).max(30).optional(),
  national_service: z.boolean().optional(),
  city: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  organization: z.object({ id: z.string().max(100).optional(), name: z.string().max(400).optional() }).optional(),
  // Accepted so that a full service payload can be posted here unchanged; the
  // first branch that carries a place is where the candidate is taken to be.
  branches: z
    .array(
      z.object({
        city: z.string().max(200).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
      }),
    )
    .max(5000)
    .optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

const MatchPayloadSchema = z.object({ services: z.array(MatchCandidateSchema).min(1).max(50) });

ingestRouter.post('/match', requireScope('ingest:write'), (req: Request, res: Response) => {
  void (async () => {
    const parsed = MatchPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_payload',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const results = [];
    for (const candidate of parsed.data.services) {
      const place = candidate.branches?.find((b) => b.city || (b.lat != null && b.lon != null));
      const match = await matchService({
        name: candidate.name,
        alternateNames: candidate.alternate_names,
        organizationName: candidate.organization?.name,
        organizationId: candidate.organization?.id,
        city: candidate.city ?? place?.city,
        lat: candidate.lat ?? place?.lat,
        lon: candidate.lon ?? place?.lon,
        phoneNumbers: candidate.phone_numbers,
        urls: (candidate.urls ?? []).map((u) => (typeof u === 'string' ? u : u.href)),
        responses: candidate.responses,
        nationalService: candidate.national_service,
        limit: candidate.limit,
      });
      results.push({ external_id: candidate.external_id ?? null, name: candidate.name, ...match });
    }

    res.json({
      summary: results.reduce<Record<string, number>>((acc, r) => {
        acc[r.decision] = (acc[r.decision] ?? 0) + 1;
        return acc;
      }, {}),
      results,
    });
  })().catch((err: Error) => {
    console.error('[error] match:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

/**
 * Records that a document from this source is about an existing service.
 *
 * The other half of the match. When the answer was `link`, the agreement should
 * not be pushed as a service — it is a second sighting of one already here — but
 * the sighting is worth keeping: it is the provenance that says a municipality
 * contracts for this, and it is what makes the next run of the pipeline
 * recognise the document instead of deciding again.
 *
 * A link from a trusted source is recorded as confirmed and appears on the
 * service's card as a data source. From anything else it waits, exactly as a
 * pushed service does.
 */
const LinkSchema = z.object({
  service_id: z.string().min(1).max(300).describe('The service this document is about, as returned by /match.'),
  external_id: z.string().min(1).max(200).describe('Your id for the document. Re-sending it updates the same link.'),
  kind: z.string().max(40).optional().describe('What the document is. Defaults to "agreement".'),
  title: z.string().max(400).optional().describe('Shown to a reviewer, and on the card once confirmed.'),
  confidence: z.number().min(0).max(1).optional(),
  method: z.enum(['matcher', 'manual', 'declared']).optional(),
  evidence: z.record(z.string(), z.unknown()).optional().describe('Whatever the decision was made on. Kept verbatim.'),
  note: z.string().max(2000).optional(),
});

const LinksPayloadSchema = z.object({
  dry_run: z.boolean().optional(),
  links: z.array(LinkSchema).min(1).max(200),
});

ingestRouter.post('/links', requireScope('ingest:write'), (req: Request, res: Response) => {
  void (async () => {
    const key = req.apiKey!;
    if (!key.sourceId || !key.sourceSlug) {
      res.status(403).json({ error: 'key_has_no_source', message: 'This key is not attached to a source.' });
      return;
    }

    const parsed = LinksPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_payload',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { dry_run: dryRun = false, links } = parsed.data;
    const confirmed = key.trustLevel >= AUTO_PUBLISH_TRUST_THRESHOLD;
    const results: {
      external_id: string;
      service_id: string;
      status: 'confirmed' | 'proposed' | 'rejected' | 'not_found';
      link_id?: string;
    }[] = [];

    for (const link of links) {
      const { rows: exists } = await query<{ id: string }>('SELECT id FROM services WHERE id = $1', [link.service_id]);
      if (!exists.length) {
        results.push({ external_id: link.external_id, service_id: link.service_id, status: 'not_found' });
        continue;
      }
      if (dryRun) {
        results.push({
          external_id: link.external_id,
          service_id: link.service_id,
          status: confirmed ? 'confirmed' : 'proposed',
        });
        continue;
      }

      const status = confirmed ? 'confirmed' : 'proposed';
      const { rows } = await query<{ id: string }>(
        `INSERT INTO service_links (service_id, source_id, external_id, kind, title, confidence,
                                    method, evidence, status, note, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (source_id, external_id, service_id) DO UPDATE SET
           -- A field left out of a re-send is unknown, not empty. Overwriting
           -- with the absence erased the evidence and confidence a link was
           -- decided on the moment a caller re-sent it without them.
           kind = EXCLUDED.kind, method = EXCLUDED.method,
           title = COALESCE(EXCLUDED.title, service_links.title),
           confidence = COALESCE(EXCLUDED.confidence, service_links.confidence),
           evidence = CASE WHEN EXCLUDED.evidence = '{}'::jsonb THEN service_links.evidence
                           ELSE EXCLUDED.evidence END,
           note = COALESCE(EXCLUDED.note, service_links.note),
           -- A link a person has already ruled on is not re-decided by the next
           -- nightly run: re-sending it refreshes the evidence, nothing else.
           status = CASE WHEN service_links.decided_by IS NULL THEN EXCLUDED.status ELSE service_links.status END
         RETURNING id`,
        [
          link.service_id,
          key.sourceId,
          link.external_id,
          link.kind ?? 'agreement',
          link.title ?? null,
          link.confidence ?? null,
          link.method ?? 'matcher',
          JSON.stringify(link.evidence ?? {}),
          status,
          link.note ?? null,
          confirmed ? `api_key:${key.name}` : null,
          confirmed ? new Date().toISOString() : null,
        ],
      );

      if (confirmed) await recordProvenance(link.service_id, link.title ?? link.kind ?? 'agreement', key.sourceSlug, link.external_id);

      results.push({
        external_id: link.external_id,
        service_id: link.service_id,
        status,
        link_id: rows[0]?.id,
      });
    }

    res.status(dryRun ? 200 : 202).json({
      dry_run: dryRun,
      confirmed_immediately: confirmed,
      summary: results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {}),
      results,
    });
  })().catch((err: Error) => {
    console.error('[error] links:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

/**
 * A confirmed link is provenance, and provenance belongs on the card.
 *
 * `data_sources` is what the public record shows for "where did this come from",
 * so a service a municipality contracts for should say so there rather than only
 * in a table an administrator can see.
 */
async function recordProvenance(serviceId: string, title: string, sourceSlug: string, externalId: string): Promise<void> {
  const entry = `${title} (${sourceSlug}:${externalId})`;
  await query(
    `UPDATE services
        SET data_sources = CASE WHEN $2 = ANY(data_sources) THEN data_sources
                                ELSE array_append(data_sources, $2) END,
            updated_at = now()
      WHERE id = $1`,
    [serviceId, entry],
  );
}

/** The links this source has recorded, so a re-run can skip what it has done. */
ingestRouter.get('/links', requireScope('ingest:write'), (req, res) => {
  void (async () => {
    const key = req.apiKey!;
    const status = String(req.query['status'] ?? '');
    const externalId = String(req.query['external_id'] ?? '');
    const { rows } = await query(
      `SELECT l.id, l.service_id, s.name AS service_name, l.external_id, l.kind, l.title,
              l.confidence, l.method, l.status, l.note, l.decided_by, l.decided_at, l.created_at
         FROM service_links l
         JOIN services s ON s.id = l.service_id
        WHERE l.source_id = $1
          AND ($2 = '' OR l.status = $2)
          AND ($3 = '' OR l.external_id = $3)
        ORDER BY l.created_at DESC
        LIMIT 500`,
      [key.sourceId, status, externalId],
    );
    res.json({ links: rows });
  })().catch((err: Error) => {
    console.error('[error] list links:', err.message);
    res.status(500).json({ error: 'internal_error' });
  });
});

/** Withdraws a service. Archived rather than deleted, so the record survives. */
ingestRouter.delete('/services/:externalId', requireScope('ingest:write'), (req, res) => {
  void (async () => {
    const key = req.apiKey!;
    const serviceId = `${key.sourceSlug}:${req.params['externalId']}`;
    const { rowCount } = await query(
      `UPDATE services SET status = 'archived', updated_at = now()
        WHERE id = $1 AND source_id = $2`,
      [serviceId, key.sourceId],
    );
    if (!rowCount) {
      res.status(404).json({ error: 'not_found', message: `No service ${serviceId} from this source` });
      return;
    }
    await query(
      `INSERT INTO change_log (entity_type, entity_id, action, actor, source_id)
       VALUES ('service', $1, 'archive', $2, $3)`,
      [serviceId, `api_key:${key.name}`, key.sourceId],
    );
    await query(
      `INSERT INTO system_state (key, value) VALUES ('cards_need_rebuild', 'service archived')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
    res.json({ service_id: serviceId, status: 'archived' });
  })().catch((err: Error) => {
    console.error('[error] ingest delete:', err.message);
    res.status(500).json({ error: 'internal_error' });
  });
});

/** What this key is allowed to do — the first call an integrator makes. */
ingestRouter.get('/whoami', requireScope('ingest:write'), (req, res) => {
  const key = req.apiKey!;
  res.json({
    key_name: key.name,
    source: key.sourceSlug,
    scopes: key.scopes,
    trust_level: key.trustLevel,
    publishes_immediately: key.trustLevel >= AUTO_PUBLISH_TRUST_THRESHOLD,
  });
});
