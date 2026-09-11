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
checked against
[`prompts/agreement-extraction.schema.json`](../prompts/agreement-extraction.schema.json)
the moment it arrives. One that does not validate gets a single corrective turn
with the list of what is wrong; a document that still fails is reported as a
failure, never salvaged by guessing at what the prose meant.

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

PDFs go to the model as documents, up to 50 MB each; one too large to travel
inside a request is uploaded to that provider's file store for the length of the
read and deleted afterwards. Text, Markdown, JSON, CSV and HTML are read as text.
A `.doc` or `.docx` has to be converted first.

`--model` takes any model in the catalog (`--models` lists them with their prices
and the key each needs), so the model chosen on the screen is the one the archive
is read with, through the same code.

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

## Trying it on a handful first

Before an archive, a dozen documents — and the admin's **הסכמים** tab exists for
exactly that. It takes a PDF or a text file, runs the same prompt and the same
matcher as the script, and shows the verdict and the services it extracted, what
the corpus already holds for each one, and what that document cost.

## Choosing a model

The same document can be sent to up to six models at once, from three providers:

| Provider | Key | Models |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | Claude Opus 5, Sonnet 5, Haiku 4.5 |
| OpenAI | `OPENAI_API_KEY` | GPT-5.6 Sol, Terra and Luna, GPT-5.4 mini |
| Google | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Gemini 3.1 Pro, 3.8 Flash, 3.5 Flash-Lite |

The catalog, with prices, is `packages/ingest/src/reader/models.ts` — one list for
the screen, the script and the cost arithmetic. Prices are the ones the
providers published in September 2026; the screen shows the date beside them.
On opening, the screen asks each provider which models its key can use, so a
retired id or a model not enabled on the account shows as unavailable instead of
failing on a real document.

Every model is held to the same things: the same prompt, JSON mode rather than
each provider's structured outputs (the schema is too large for all three), the
same validator, and the same single corrective turn. That is what makes the
answers comparable. The effort control — how hard the model thinks — is mapped
onto each provider's own parameter and moved to the nearest level a model
supports; Haiku 4.5 has none.

The comparison lays the runs side by side: verdict, subject, authority,
provider, how many services, what the corpus said about them, cost, time and
tokens. Services are lined up by name rather than by position, and every cell
where the models disagree is marked. A service one model found and another did
not is shown as missing, not as a different value.

Every run is kept (`agreement_runs`), so the totals are measured across
everything tried: per model, the cost per document once the prompt is cached,
the time, the failures, and how often its verdict matched what the other models
reading the same document said. Agreement is not accuracy — three models can
agree and all be wrong — but it is the one quality signal that needs no answer
key, and a model that is regularly the odd one out is the one whose readings are
worth checking by hand.

For a scanned document the providers differ most in how a page is billed, not in
their headline rates: Gemini charges a flat 560 tokens a page, where Claude and
GPT bill the page as an image at a resolution they choose. On a 111-page scan
that is the difference between cents and dollars per document, which is why the
screen reports what each run actually cost rather than estimating from a price
list.

The OpenAI and Google connectors call the providers' REST endpoints directly;
what they send and how they read the replies is covered by
`packages/ingest/src/reader/reader.test.ts` (`npm test`).

The cost is split the way it behaves at scale. The prompt carries the whole
taxonomy and is identical for every document, so it is written to the model's
cache once and read back at a tenth of the price after that. The screen
therefore projects from the **marginal** price — what a document costs once the
prompt is already cached — rather than from the first document's total, which
pays for the cache write and would overstate a ten-thousand-document bill
several times over. Read documents one after another on the screen and the
projection for 100, 1,000 and 10,000 settles as the sample grows.

Acting from the screen is one service and one click at a time, on purpose: it is
for building confidence, and volume belongs in the script. A link is confirmed at
once, since a person pressing the button is the review a proposed link would
wait for. A created service is a **draft** in the review queue, because it was
read out of a PDF by a model and publication is a person's decision.

## Why the shape is checked afterwards, not enforced

The obvious tool for "reply in exactly this JSON shape" is structured outputs,
and the pipeline started there. It does not survive this schema. Three limits
were hit in turn, each one a request rejected before the model read anything:
no `$comment` and no numeric or length bounds; at most 16 union-typed
parameters; and finally a ceiling on the size of the compiled grammar itself,
which a schema of nested services — each with an organization and a list of
branches, every key required — exceeds however it is written.

So the shape is held by the prompt, which carries the schema, and checked when
the answer arrives, against the same file, by `schemaErrors` in `@ssil/core`.
An answer that does not validate gets one more turn with the list of what is
wrong; a document that fails twice is reported rather than retried again. Both
turns are billed, and the cost the screen and the report show includes them —
an `attempts` of 2 on a document is the visible trace of that.

Two conventions from the structured-output attempt remain, because they are
right on their own terms. Text the document does not carry is `""`, converted to
`null` the moment the answer is parsed, and `null` survives only on
`payment_required` and `annual_value_ils`, where "not stated" and "no" are
different answers. Constraints such as "between 0 and 1" live in descriptions,
where the model reads them, and in the pipeline's validation, where they are
enforced.

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

It also checks the model catalog and the batch lifecycle, without paying for a
read: a batch is only sent to a model whose provider has no key, which fails at
once and for nothing, and the check is that the failure is recorded, names the
variable to set and costs zero. When every provider has a key it says so and
skips that part.

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
