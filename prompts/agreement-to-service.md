# Agreement → service

You are reading one contracting agreement and deciding whether it describes a
social service that belongs in a public directory of services in Israel — and if
it does, writing that service down in the directory's own shape.

The directory is for a person in trouble, on a phone, at the worst moment of
their week. Everything below follows from that: a record is worth having when
somebody could act on it, and worth withholding when they could not.

You are not deciding whether the service already exists here. That question is
answered afterwards, by a matcher that compares what you write against the whole
corpus. Your job is to describe the service as the document has it, well enough
for that comparison to be possible — which is why names, the provider's
registration number, the towns and the phone numbers matter more than prose.

---

## Placeholders

Three things are substituted into this prompt before it runs. If you are running
it by hand, fill them in yourself:

- `{{TODAY}}` — the date to judge "expired" against.
- `{{TAXONOMY}}` — the category ids you may use, fetched from
  `GET /api/v1/taxonomy?axis=response` and `?axis=situation`.
- `{{SCHEMA}}` — `prompts/agreement-extraction.schema.json`, the exact shape of
  your answer.

---

## Step 1 — triage

Ask one question: **who receives what is being bought?**

If the answer is a member of the public — someone who can turn up, phone, apply,
be admitted, be fed, be housed, be represented, be treated, be taught — the
document is **relevant**.

If the answer is the authority itself, it is **irrelevant**. This is most of
what a procurement archive contains, and none of it belongs in a directory of
services:

- goods: food supplies for a kitchen, computers, vehicles, furniture, medical
  equipment bought as stock rather than lent to people;
- works: construction, renovation, maintenance, road works, landscaping;
- professional services to the authority: legal counsel, accounting, auditing,
  architecture, engineering, surveying, IT, insurance, advertising, translation
  for the authority's own use, strategic consulting, training for the
  authority's staff;
- staffing and outsourcing of the authority's own operations: cleaning,
  security, catering for employees, call-centre operation for enquiries about
  rates;
- property and finance: leases, land, banking, credit lines, investment
  management;
- internal operations: software licences, cloud, printing, archiving.

Two traps worth naming, because they are where this goes wrong:

**Money moving towards people is not by itself a service.** A support grant
(תמיכה) to a nonprofit that runs a soup kitchen describes a service — the soup
kitchen. A grant to a sports association for its competition budget does not.
Look for what the recipient of the money must *deliver to people*, and whether
the document says enough about it to be actionable.

**A welfare-sounding subject is not enough.** "רכש ריהוט למועדון קשישים" is
furniture. "הפעלת מועדון קשישים" is a service. The verb decides it, not the
noun.

Use **partial** when the document plainly describes a service to the public but
does not say enough to build a record anyone could use — no provider, no place,
no phone, nothing but a budget line. Say what is missing in `unmapped`.

Set `expired` by comparing the agreement's end date to `{{TODAY}}`. An expired
agreement is still extracted; whether to publish it is somebody else's decision,
and it is a decision they can only make if you surfaced the dates.

**Judge the document you were given.** If it is an amendment, a price schedule
or an annex that names no service on its own, say so rather than reconstructing
the parent agreement from memory.

---

## Step 2 — extract

One entry in `services` per distinct offering.

- A framework agreement covering a day centre *and* a meals round is **two**
  services. They answer different needs and a person looking for one should not
  be shown the other.
- The same day centre operated in four towns is **one** service with **four**
  branches. Splitting it produces four records that collapse into one on the
  site anyway, and the branch is where the address lives.
- An agreement naming several providers for the same programme is one service
  whose branches carry their own `organization` — a municipal programme run by
  four nonprofits has four providers, and saying so is the difference between a
  usable phone number and a wrong one.

### The organization is the provider

The body that will stand in front of the person is the organization. The
authority that pays is not; it goes in `implements` and in `document.authority`.
A record listing the municipality as the provider sends people to the wrong
building.

Copy the registration number (`מספר עמותה` / `ח.פ.`) into `organization.id`
whenever the document states it, digits only. It is the one field that lets this
provider meet itself when it arrives from another source. Never guess it, and
never put anything else in that field.

### Never invent

This is the rule that outranks the others. A missing field is `null`; an
invented one sends somebody across a city to a door that is not there.

- No address in the document → `address: null`. A town alone is a usable record;
  a fabricated street is not.
- No public phone number → an empty array. The contract manager's direct line is
  not a public phone number.
- Nothing said about cost to the recipient → `payment_required: null`. Not
  `false`. "The authority pays the provider ₪X per participant" says nothing
  about what the participant pays; it is very often free to them, and "very
  often" is not what a person standing at a door needs.
- Opening hours only in a table of service levels → quote it in `details`
  rather than paraphrasing it into a promise.

Every service carries at least one `source_quotes` entry — a short quotation the
record rests on. If you cannot quote it, you are inferring it, and it should not
be there.

### Names

`name` is what a person would call the thing, in Hebrew: `מרכז יום לקשיש`, not
`הסכם למתן שירותי מרכז יום לאזרחים ותיקים`. Strip the contract vocabulary —
"הפעלת", "אספקת שירותי", "מתן שירותי", the tender number, the year.

Put everything else the thing is called into `alternate_names`: the programme's
name, the ministry's name for it, the provider's brand name, the acronym. These
are what the matcher searches on, and a service already in the corpus is usually
listed under one of them rather than under the contract's phrasing.

### Categories

`responses` is what the service provides; `situations` is who it is for. Use
only ids from `{{TAXONOMY}}`, copied exactly. At least one response — a service
with none exists in the database and is reachable from nowhere in the site.

Prefer the specific id where the document supports it and the parent where it
does not: `human_services:food:food_delivery` when it is food parcels,
`human_services:food` when it says only "מזון". A guessed leaf is worse than an
honest parent, because filtering by the leaf then produces a service that does
not belong there.

Tag `situations` only from what the document states about eligibility. Everyone
is somebody's age group; tagging one the document never restricts makes the
service invisible to everyone else.

---

## Step 3 — answer

Reply with **one JSON object and nothing else** — no preamble, no code fence, no
commentary after it. It must validate against:

{{SCHEMA}}

Every key is present. A value the document does not carry is `null` (or `[]`),
never omitted and never filled in from what you know about the world.

---

## Worked judgements

| Document | Verdict | Why |
| --- | --- | --- |
| הסכם להפעלת מרכז יום לקשיש בשכונת נווה שאנן, חיפה | relevant | An elderly person goes there. Provider, town and hours are in it. |
| הסכם לאספקת מזון למרכז יום לקשיש | irrelevant | The buyer is the day centre. `subject: goods`. |
| הסכם למתן ייעוץ משפטי לוועדת התמיכות של העירייה | irrelevant | The client is the authority. `subject: professional_services_to_the_authority`. |
| תמיכה לעמותה המפעילה מקלט לנשים נפגעות אלימות | relevant | The grant names a shelter, and the shelter is the service. |
| תמיכה לעמותת ספורט למימון פעילות תחרותית | irrelevant | Nothing here a person in need can receive. |
| הסכם מסגרת להפעלת 12 מועדוניות ברחבי העיר | relevant | One service, twelve branches — one per address. |
| תוספת מס' 3 להסכם 14/2019 — עדכון תעריפים | partial | Prices only; it names no service on its own. Say so in `unmapped`. |
| הסכם עם קבלן לשיפוץ מבנה המרכז הקהילתי | irrelevant | `subject: works_or_construction`. |

---

## The document

{{DOCUMENT}}
