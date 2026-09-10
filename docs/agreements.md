# Agreements as a source

A repository of contracting agreements — a municipality's contracts with the
nonprofits that run its day centres, a ministry's framework agreements, support
grants to organisations that feed people — is a description of the country's
social services written for auditors. Most of it is not about services at all,
and the part that is describes services this corpus already holds.

This is the pipeline that turns such an archive into records, and the reasoning
behind each of its parts.

## The three kinds of document

An archive of agreements contains, roughly in this proportion:

1. **Agreements about services already in the corpus.** The commonest case, and
   the one that matters most: the service arrived here earlier from another
   source, and the agreement is a second sighting of it. Pushing it produces a
   duplicate; discarding it loses the provenance.
2. **Agreements about services nobody has collected.** Welfare services
   contracted locally are exactly what a national directory scraped from
   nonprofit registries misses. These are the reason to do this at all.
3. **Agreements about nothing a person can receive.** Furniture, construction,
   legal counsel to the authority, cleaning, software. Most of the archive.

Each needs a different outcome, so the pipeline has to be able to tell them
apart — and to say which it thinks it is looking at, and why.

## The four stages

```
document ──read──▶ extraction ──match──▶ decision ──push──▶ service or link
                       │                     │
                    warnings              rationale
```

**Read.** [`prompts/agreement-to-service.md`](../prompts/agreement-to-service.md)
goes to the model as a system prompt with the live taxonomy substituted into it,
and the document as its own content block — a PDF stays a PDF. The answer is
constrained to
[`prompts/agreement-extraction.schema.json`](../prompts/agreement-extraction.schema.json)
by the API's structured-output mode, so it is JSON of the right shape or it is a
failure, never prose to be salvaged.

Two properties of that schema are worth naming. Its `services` entries are, once
nulls are dropped, exactly the payload `POST /api/v1/ingest/services` takes — no
mapping layer sits between what the model writes and what is pushed, so there is
nowhere for a field to be quietly renamed or lost. And every service carries
`source_quotes`: a record that cannot be quoted from the document was inferred,
and a reviewer can see that without opening the PDF.

**Match.** `POST /api/v1/ingest/match` puts every extracted service to the whole
corpus and answers `link`, `review` or `new`. This is deliberately not the
model's job. Identity between records is decided by a deterministic function of
the corpus, so the same candidate always gets the same answer and a person can
reproduce it; a model that hallucinated a match would attach an agreement to the
wrong shelter and nobody would find out.

**Push.** `new` goes to `POST /api/v1/ingest/services` as an ordinary service.
`link` goes to `POST /api/v1/ingest/links`, which records the agreement against
the service that already exists and adds it to that service's data sources.
`review` goes nowhere: it waits in the report, and in the admin, for a person.

**Report.** `agreements-out/report.md` — what was read, what it cost, and every
document that needs a person, with the candidates and the reason it stopped.

## How matching decides

Five signals, each scored 0–1 and each reported separately:

| Signal | Weight | What it is |
| --- | --- | --- |
| name | 0.45 | Best similarity across the name and its alternates, after Hebrew normalisation |
| organization | 0.25 | 1 when the registration numbers agree, otherwise name similarity |
| taxonomy | 0.12 | Jaccard overlap of the response tags, each expanded to its ancestors |
| geography | 0.10 | Same town, or how near the two points are |
| contact | 0.08 | A shared phone number, or a shared web host |

Three decisions in that design carry most of the behaviour.

**A missing signal is missing, not zero.** A candidate with no city, no tags and
no phone number is not a bad match; it is an unverified one. Unknown components
drop out of the weighted average rather than dragging it down — otherwise every
thin record would score low, land on `new`, and duplicate something.

**Contact is weighted low and gates high.** A shared phone number is the most
specific signal here and also the most misleading: it is usually the
organisation's switchboard, which every service it runs lists. So it contributes
little to the score, but it is one of the two things that can corroborate a
match. `link` requires a total above 0.78, a name above 0.6, **and** either the
same organisation or a shared number. A name alone, however perfect, is sent to
a person.

**Two indistinguishable candidates are not an answer.** When the runner-up is
within 0.04 of the best, the decision is `review` and names both. A chain
running the same programme in forty towns produces exactly this shape, and
picking the higher of two identical rows would attach the agreement to an
arbitrary branch.

## What a link is

`service_links` records the claim "this document is about that service" — with
who made it, how confident, on what evidence, and whether a person has ruled on
it. It is not a merge. The service is untouched apart from gaining a line of
provenance; the claim can be rejected later, and rejecting it is what tells the
next run of the pipeline that this document describes a service the corpus does
not have.

A link a person has decided is never re-decided by a later push. Re-sending the
same agreement refreshes its evidence and nothing else — otherwise the nightly
run would quietly overturn every editorial judgement made since the last one.

## Running it

```bash
# read only — nothing is written, and the report is the point
node scripts/agreements.mjs ./agreements --out ./agreements-out

# read and ask the corpus, still writing nothing
INGEST_KEY=ssil_... node scripts/agreements.mjs ./agreements --match --url https://...

# act on the answers, as a dry run
INGEST_KEY=ssil_... node scripts/agreements.mjs ./agreements --push --url https://...

# and for real
INGEST_KEY=ssil_... node scripts/agreements.mjs ./agreements --push --commit --url https://...
```

`--push` without `--commit` is a dry run by design. A directory of agreements is
a directory of claims about the world, and the first run is for finding out how
good they are.

`--resume` skips documents that already have output, so a run interrupted after
two hundred PDFs costs nothing to continue. The prompt — which carries the whole
taxonomy — is cached between documents, so it is paid for once per run rather
than once per document.

PDFs go to the model as documents, up to 25 MB each. Text, Markdown, JSON, CSV
and HTML are read as text. A `.doc` or `.docx` has to be converted first.

Set up the source before the first push, so everything it writes is attributed
and inherits a trust level:

```bash
curl -X POST "$BASE/api/admin/sources" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"agreements","name":"הסכמי התקשרות","kind":"manual","trust_level":50}'
```

A trust level below 70 means everything this source pushes waits for review —
which is the right setting until a few dozen documents have been checked by
hand. Raising it later is one call.

## Checking it

```bash
ADMIN_TOKEN=... node scripts/smoke-agreements.mjs https://...
```

Pushes one deliberately odd-sounding service and then asks the matcher about
variations of it — the same record, the same name from a different body, a name
nothing resembles — checking that each gets the answer it should, that a bare
name is never linked on its own, that a link surfaces as provenance, and that a
re-push cannot overturn a decision a person made. Everything is namespaced under
a throwaway source and purged at the end.

## What this deliberately does not do

**It does not merge organisations.** Two providers with similar names stay two
organisations unless they share a registration number. Merging them is a
different operation with a different blast radius.

**It does not publish on the model's say-so.** A source below the trust
threshold queues everything, and the `review` decision exists precisely so that
the uncertain cases reach a person instead of being forced into yes or no.

**It does not decide whether an expired agreement should be listed.** It reports
the dates and flags the document; whether a service contracted until 2023 is
still running is a question about the world, and the document cannot answer it.
