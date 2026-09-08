# social-services-il

An open platform for Israel's social services: a public site built for someone
in distress on a phone, an admin for ingesting services from many kinds of
source, a documented read/write API, and an MCP server so AI assistants can
query the same data.

**Live:** https://social-services-il-zomerg.xhostd.app

Israel already has a national map of social services at
[kolsherut.org.il](https://www.kolsherut.org.il/), operated by כל זכות, holding
about 15,000 services across two taxonomy axes. This project is a separate,
independent implementation over the same public data model, aimed at three gaps
in that system:

- **There is no programmatic way to submit or update a service.** An
  organisation must type its services into a third-party nonprofit registry and
  wait to be scraped, or send an email.
- **There is no documented public API and no agent interface.** The endpoints
  exist but are undocumented and unstable, and the CKAN host that was meant to
  publish bulk dumps no longer resolves in DNS — so there is currently no bulk
  export of this data at all.
- **Free-text search does nothing server-side.** Typing is first converted into
  taxonomy ids by an autocomplete index; anything that index does not recognise
  is unreachable. There is also no pagination, and location filtering happens in
  the browser over the entire result set.

[`docs/existing-system.md`](docs/existing-system.md) has the full research notes
— data model, ranking rules, ingestion sources, live API — and a table of what
this project keeps, changes and adds.

## What works today

Loaded with the real corpus: **11,024 services** from **2,534 organizations**
across **17,944 branches**, producing **16,371 cards** in **742 cities**.

| | |
| --- | --- |
| Public site | Hebrew, Arabic, Russian and English; mobile-first; results actionable without opening them; urgent helplines outside the ranked results |
| Search | Hebrew normalisation with prefix variants, synonyms, facets, distance ranking, collapsing, and a misspelling fallback. Free text answers in 95–300 ms |
| Read API | Documented and versioned, with bulk NDJSON export and `updated_since` |
| Write API | Idempotent push, `dry_run`, per-item errors and warnings, trust-based publish or review |
| MCP | Eight read-only tools, two resources, one guided prompt; no credentials |
| Admin | Google sign-in by invitation, moderation, sources, API keys, diagnostics |
| Importer | Converts the six-table export and pushes it through the public write API |

Three suites cover it end to end — 97 checks, all passing against production:

```bash
node scripts/smoke.mjs https://social-services-il-zomerg.xhostd.app
node scripts/smoke-mcp.mjs https://social-services-il-zomerg.xhostd.app
ADMIN_TOKEN=... node scripts/smoke-ingest.mjs https://social-services-il-zomerg.xhostd.app
```

### What the import left behind

6,562 service-branch pairs are held back because their address never geocoded
and they are not marked nationwide — a card with neither a point nor a
nationwide flag cannot answer "where do I go". They are listed in the admin's
diagnostics with the address that failed, which is the shortest route to fixing
them. 793 services carry no response tag and 11,036 are inactive upstream;
neither is imported.

Two fields are deliberately not imported. `boost` holds values up to 300, and
this system treats boost as a power of ten, so importing it verbatim would
produce infinities — editorial ranking is better re-established deliberately
than inherited with unknown semantics. And two services reference a taxonomy id
that does not exist in the export's own taxonomy tables, one of them visibly
corrupt (`human_services:hehuman_services:health:...`); they are reported rather
than guessed at.

## Two things only you can do

**Google sign-in** needs OAuth credentials, which have to be created by hand in
the Google Cloud console. Create an OAuth client (type: Web application) with
the redirect URI `https://<your-host>/api/auth/google/callback`, then:

```bash
# via the xhostd MCP, or the console
set_env GOOGLE_CLIENT_ID=...      # secret
set_env GOOGLE_CLIENT_SECRET=...  # secret
```

`SESSION_SECRET` is already set. Until the two Google values exist, the admin
falls back to the bootstrap token in `ADMIN_TOKEN`, which is also how the first
administrator invites themselves.

**Real data** is loaded. To reload or update it:

```bash
# taxonomy first — the export's tree is a superset of the published one and
# carries 498 hand-built synonym terms that exist nowhere else
node scripts/import-airtable.mjs ./export --taxonomy --url https://... --admin <token>

# convert and read before writing anything
node scripts/import-airtable.mjs ./export --services --out payload.json

# then push
node scripts/import-airtable.mjs ./export --services --url https://... --key ssil_...
```

It matches files by their columns rather than their names, and honours the
curation the export carries: `final_responses` and `final_situations` over the
raw columns, `name_manual` over `name`, and a hand-corrected coordinate over the
geocoder's.

## Stack

TypeScript end to end. Express and Postgres (with PostGIS) on the server, React
with Vite for the public site and the admin. Deployed on
[xhostd](https://xhostd.com).

```
packages/
  core/     shared types, Hebrew normalisation, card identity, ranking
  db/       migrations, query helpers, the search query
  ingest/   taxonomy loader, fixtures, connector definitions
  api/      Express: public API, admin API, write API, MCP; serves both SPAs
  web/      the public site and the developer documentation
  admin/    the admin interface
docs/       existing-system.md, openapi.json
scripts/    smoke suites, the importer, the spec dump
```

## Development

```bash
npm install
npm run build
DATABASE_URL=postgres://... node packages/db/dist/migrate.js
PORT=3000 node packages/api/dist/server.js
```

Without `DATABASE_URL` the server still starts and `/api/health` reports the
database as `not-configured`, which is enough for front-end work.

## Notes on the design

A few decisions are load-bearing and easy to undo by accident:

- **Hebrew tokens are indexed in two forms**, as written and with one leading
  particle removed, and every query term matches either. Stripping destructively
  cannot work: `מזון` loses its `מ` and `למזון` loses its `ל`, so the document
  and the query land on different tokens and never meet.
- **Geography lives in its own table** and keeps the geocoder's answer separate
  from an editor's correction, so re-running a geocoder cannot move a pin a
  human already fixed.
- **Tags carry an origin.** Manual beats everything, and an LLM suggestion never
  reaches the public site until a person promotes it.
- **`national_service` is a fact, not missing data.** A radius or viewport search
  always includes nationwide services.
- **Cards record why a row was excluded** instead of dropping it silently, so
  "why is my service not showing" is answerable in the admin.
- **The scheduler runs in-process.** Each channel on the host gets its own
  Postgres, so a separate worker channel would connect to an empty database.

## Data and licensing

The service data this platform is designed to hold is public information
published by nonprofits, government ministries and local authorities. The
taxonomy derives from
[openeligibility](https://github.com/kolzchut/openeligibility), itself a fork of
the US Open Eligibility Project.

This code is MIT licensed. The data it serves carries its own terms from each
upstream source, recorded per record.
