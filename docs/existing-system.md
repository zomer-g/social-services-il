# The existing system: kolsherut.org.il

Research notes gathered before designing this project. Everything here was
verified against the live site, its published configuration files, or the
open-source repositories under [`github.com/kolzchut`](https://github.com/kolzchut).
Recorded because the data model and the ranking rules encode real editorial
judgement that this project deliberately carries forward.

## What it is

"כל שירות" maps roughly 15,000 social services in Israel — from nonprofits,
government ministries and local authorities — onto two taxonomy axes:
**situations** (`human_situations`) × **responses** (`human_services`). It is
operated by כל זכות with support from the Ministry of Justice and the National
Digital Agency.

## Repositories

| Repo | Purpose | Stack |
| --- | --- | --- |
| [`kolzchut/srm-etl`](https://github.com/kolzchut/srm-etl) | ETL: scrape → Airtable staging → derive → Elasticsearch | Python, `dataflows` |
| [`kolzchut/srm-api`](https://github.com/kolzchut/srm-api) | Search API | Python, Flask, `apies` over Elasticsearch |
| [`kolzchut/srm-frontend`](https://github.com/kolzchut/srm-frontend) | Web app (generation 1) | Angular, Mapbox GL |
| [`kolzchut/srm-devops`](https://github.com/kolzchut/srm-devops) | Helm charts, k8s | Helm/YAML |
| [`kolzchut/Kolsherut-Application`](https://github.com/kolzchut/Kolsherut-Application) | Generation 2 rewrite: ES 8, Vue front end, Cronicle scheduling | Python/Vue |
| [`kolzchut/openeligibility`](https://github.com/kolzchut/openeligibility) | Taxonomy, forked from the US Open Eligibility Project | YAML |

A migration from generation 1 to generation 2 is in progress.

## Data model

Five entities plus two taxonomy axes, from which a flat "card" is derived.
Field names below are exact, from `srm-etl/operators/derive/helpers.py`.

- **`organizations`** — `id`, `name`, `short_name`, `kind`, `purpose`,
  `description`, `urls[]`, `phone_numbers[]`, `email_address`, `source`, `status`
- **`branches`** — `id`, `name`, `organization`, `operating_unit`, `location`,
  `address`, `address_details`, `description`, `phone_numbers[]`,
  `email_address`, `urls[]`, `situations[]`, `services[]`
- **`services`** — `id`, `name`, `description`, `details`, `payment_required`,
  `payment_details`, `urls[]`, `phone_numbers[]`, `email_address`, `implements`,
  `situation_ids[]`, `response_ids[]`, `boost`, `data_sources[]`
- **`locations`** — `provider`, `accuracy`, `resolved_lat/lon`,
  `resolved_address`, `resolved_city`, `fixed_lat/lon`, from which `lat`, `lon`,
  `geometry` (`[lon, lat]`), `national_service` and `location_accurate` are derived
- **`responses` / `situations`** — `id` (hierarchical slug), `name`, `name_en`,
  `description`, `breadcrumbs`, `synonyms[]`, `pk`

### Four patterns worth preserving

1. **Geography lives in its own table, not on the branch**, splitting
   `resolved_*` (automatic geocoding via GovMap) from `fixed_*` (a manual
   correction that wins). This is what lets an editor fix a pin without the next
   pipeline run overwriting it.
2. **The `*_manual` override pattern** — `name_manual`,
   `situations_manual_ids`, `responses_manual_ids` beat whatever was scraped.
   Human curation layered over an automatic source.
3. **`card_id = hash(branch_id, service_id)`**, 8 hex characters, the key in the
   public URL. A card is dropped if it has no `response_ids`, or if it has no
   valid geometry and is not a national service.
4. **`national_service`** is a first-class flag, not missing geography. It
   affects ranking, filtering and display.

## Taxonomy

Three axes; two drive the cards.

| Axis | Root slug | Nodes |
| --- | --- | --- |
| Responses | `human_services` | 319 |
| Situations | `human_situations` | 388 |
| Places | `human_places` | 22 (unused) |

Node shape: `name: {source: <English>, tx: {he: <Hebrew>}}`, `slug`, `items[]`,
`pk`. Ids are the colon-delimited path, 2–4 levels deep, e.g.
`human_services:care:accessibility:translation`.

**The YAML holds Hebrew and English only — no Arabic, no Russian, and no
synonyms.** Synonyms are a hand-maintained Airtable column. Since this project
ships four languages, the taxonomy becomes a first-class table here with
per-language names and synonyms.

## Ingestion

Eleven scrapers plus one manual channel feed Airtable, which acts as the
staging and curation layer:

`revaha` (welfare bureaus, data.gov.il) · `meser` (מס"ר frameworks) ·
`mental_health_clinics` · `shil` (שי"ל advice stations) · `soproc` (BudgetKey +
"קליק לרווחה", including the 118 and 5400 hotlines) · `gilzahav` (senior
housing) · `entities` (**Guidestar API**, `/login`, `/organizations`,
`/organizationBranches`, `/organizationServices`) · `child_care` · `day_care` ·
`tipat` (well-baby clinics) · `kolzchut_orgs` · **Airtable manual entry**.

Geocoding is GovMap (`ags.govmap.gov.il`).

**Taxonomy tagging is plain string matching**, not AI: `autotagging.py` applies
a table of query-to-tag rules, matching when the value ends with the query or
contains it as a whole word.

## Search and ranking

Elasticsearch with `analysis-icu`. Field boosting is driven by the suffix of the
field name (`*_name`, `*_synonyms` get a tenfold boost on a `.hebrew`
sub-field). A Hebrew stopword list is stripped from every query (עמותה, שירות,
תוכנית, טיפול, קבוצה). Results are collapsed on `collapse_key` — the service
name plus description — so one nationwide programme offered by many
organisations does not flood the page.

`card_score` is a multiplicative heuristic: bonuses for being a national
service, for a short hotline number, for having a non-empty description, and for
being a government ministry, local authority or statutory corporation; branch
count enters damped (divided by 10 above 100 branches, otherwise square-rooted);
finally multiplied by ten to the power of `service_boost`.

## The live API

Base URL comes from `https://www.kolsherut.org.il/configs/environment.json`
(`server: https://be.kolsherut.org.il`). Four real endpoints exist; there is no
OpenAPI document and no published documentation.

| Endpoint | Notes |
| --- | --- |
| `POST /search` | Body of exactly six fields: `searchQuery`, `isFast`, `responseId`, `situationId`, `by`, `serviceName`. Sending an empty object returns 500. |
| `GET /card/<cardId>` | 39 fields, keyed by the 8-hex card id (not the service id). |
| `GET /autocomplete/<term>` | Returns `structured[]` (taxonomy suggestions carrying `responseId`/`situationId`/`bounds`/`by`) and `unstructured[]` (direct card jumps). |
| `GET /siteMapForModal` | Flat `{name, link}` list of category pages. |

Three constraints shaped this project's design:

- **`searchQuery` does nothing server-side.** Free text returns an empty array.
  The SPA first calls `/autocomplete` to convert typing into a structured
  `{responseId, situationId}` pair, then searches on that. Anything the
  autocomplete index does not recognise is unreachable.
- **There is no pagination.** `/search` returns the entire result set in one
  response — 258 records for `human_services`, 270 for one large organisation.
- **Location filtering happens in the browser**, client-side over that full
  array. The `lf`, `sf` and `rf` URL parameters are view state only, and are
  stripped from the canonical link.

Public URL scheme: `/{situation}/{response}` (e.g. `/low_income/food`),
`/{response}`, `/by-{organizationName}`, `/bsnf-{serviceName}`, and
`/p/card/c/{cardId}`. Also documented by the site itself at `/llms.txt`.

## Where the data goes

There is currently **no public bulk dump**. Every `dump_to_ckan` call in the
pipeline is commented out, and `srm.datacity.org.il` — the CKAN instance the
datapackage descriptors point at — no longer resolves in DNS. The only
reusable public artefacts are the CSV exports of the taxonomy in the
`openeligibility` repository.

## What this project does differently

| | kolsherut.org.il | This project |
| --- | --- | --- |
| Free-text search | Inert server-side; taxonomy ids only | First-class, Hebrew-normalised, with LLM query understanding |
| Pagination | None | Cursor paging with facet counts |
| Location filtering | Client-side over the whole result set | PostGIS, server-side, distance-ranked |
| Writing data | Guidestar or email only | Documented push API, webhooks, organisation portal |
| Public API | Undocumented, four endpoints | Versioned, OpenAPI, bulk export |
| Agent access | None | MCP server |
| Curation | Airtable | Purpose-built admin with source/override diffing |
| Tagging | String matching | String rules plus LLM suggestions, human-approved |
