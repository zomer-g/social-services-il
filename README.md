# social-services-il

An open platform for Israel's social services: a public site built for someone
in distress on a phone, an admin for ingesting services from many kinds of
source, a documented read/write API, and an MCP server so AI agents can query
the same data.

Israel already has a national map of social services at
[kolsherut.org.il](https://www.kolsherut.org.il/), operated by כל זכות. It holds
about 15,000 services across two taxonomy axes. This project is a separate,
independent implementation over the same public data model, aimed at three gaps:
there is no programmatic way to submit or update a service, no documented public
API or agent interface, and the search experience requires understanding the
taxonomy before it can answer a question.

See [`docs/existing-system.md`](docs/existing-system.md) for the full research
notes on that system — its data model, ranking rules and API — and what this
project keeps, changes and adds.

## Status

In progress, deployed at
[social-services-il-zomerg.xhostd.app](https://social-services-il-zomerg.xhostd.app).

Working: the schema, the openeligibility taxonomy, Hebrew search, and the public
read API — search with facets, distance ranking and collapsing, card detail,
taxonomy, autocomplete, stats and bulk export. `node scripts/smoke.mjs <url>`
exercises all of it end to end.

Next: the public site, the MCP server, the admin, and the write API.

## Stack

TypeScript end to end. Express and Postgres (with PostGIS) on the server, React
with Vite for the public site and the admin. Deployed on
[xhostd](https://xhostd.com).

```
packages/
  core/     shared types, Hebrew normalisation, card identity, ranking
  db/       migrations and query helpers
  ingest/   source connectors, scheduler, importers
  api/      Express: public API, admin API, ingest API, MCP; serves both SPAs
  web/      the public site
  admin/    the admin interface
docs/
```

## Development

```bash
npm install
npm run build
DATABASE_URL=postgres://... node packages/db/dist/migrate.js
PORT=3000 node packages/api/dist/server.js
```

Without `DATABASE_URL` the server still starts and `/api/health` reports the
database as `not-configured`, which is useful for front-end work.

## Deployment

`install.sh` runs at build time as root: installs dependencies, builds every
package, then prunes dev dependencies out of the image. `launch.sh` runs at boot
as a non-root user: applies migrations, then execs the server so it becomes PID
1 and receives shutdown signals directly.

Migrations run at boot rather than at build because `DATABASE_URL` only exists
at runtime. They are idempotent and guarded by a Postgres advisory lock, so a
rolling deploy cannot run them twice.

## Data and licensing

The service data this platform is designed to hold is public information
published by nonprofits, government ministries and local authorities. The
taxonomy derives from [openeligibility](https://github.com/kolzchut/openeligibility),
itself a fork of the US Open Eligibility Project.

This code is MIT licensed. The data it serves carries its own terms from each
upstream source, recorded per record.
