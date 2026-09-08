-- Core domain: organizations, branches, services and the geocoded locations
-- they sit at.
--
-- The shape follows the national service map's model, because that model has
-- been in production against real Israeli social-service data for years and its
-- awkward parts are load-bearing. Two in particular:
--
--   * Geography lives in its own table, not on the branch, and separates the
--     geocoder's answer from an editor's correction. Re-running a geocoder must
--     never silently move a pin a human already fixed.
--   * A service is many-to-many with both branches and organizations. The same
--     food programme is genuinely run by several nonprofits at many sites.

CREATE TYPE ssil_status AS ENUM ('draft', 'review', 'published', 'archived');

-- Geocoding quality, in the vocabulary the Israeli geocoders return. Anything
-- at building or street level is precise enough to navigate to; the rest is
-- shown with a warning, since a pin on a city centroid misleads.
CREATE TYPE ssil_accuracy AS ENUM (
  'rooftop',
  'building',
  'street',
  'locality',
  'region',
  'approximate',
  'unknown'
);

CREATE TABLE locations (
  -- Normalised address string. Sharing one row between every branch at the
  -- same address means a geocoding fix, or a rate-limited lookup, happens once.
  id                text PRIMARY KEY,
  raw_address       text NOT NULL,

  -- What the geocoder said.
  provider          text,
  accuracy          ssil_accuracy NOT NULL DEFAULT 'unknown',
  resolved_lat      double precision,
  resolved_lon      double precision,
  resolved_address  text,
  resolved_city     text,

  -- What a human said, which wins.
  fixed_lat         double precision,
  fixed_lon         double precision,
  fixed_by          text,
  fixed_at          timestamptz,
  fixed_note        text,

  -- A service delivered anywhere in the country has no point at all. This is a
  -- fact about the service, not a failed geocode, and the two must not be
  -- confused: one is displayed as nationwide, the other as missing data.
  national_service  boolean NOT NULL DEFAULT false,

  -- Maintained by trigger rather than generated, so the PostGIS constructors do
  -- not have to be provably immutable on every host we run on.
  lat               double precision,
  lon               double precision,
  geom              geography(Point, 4326),
  location_accurate boolean NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION locations_derive() RETURNS trigger AS $$
BEGIN
  NEW.lat := COALESCE(NEW.fixed_lat, NEW.resolved_lat);
  NEW.lon := COALESCE(NEW.fixed_lon, NEW.resolved_lon);

  IF NEW.national_service OR NEW.lat IS NULL OR NEW.lon IS NULL THEN
    NEW.geom := NULL;
  ELSE
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  END IF;

  -- A hand-placed pin counts as accurate whatever the geocoder thought.
  NEW.location_accurate :=
    (NEW.fixed_lat IS NOT NULL AND NEW.fixed_lon IS NOT NULL)
    OR NEW.accuracy IN ('rooftop', 'building', 'street');

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER locations_derive_trg
  BEFORE INSERT OR UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION locations_derive();

CREATE INDEX locations_geom_idx ON locations USING GIST (geom);
CREATE INDEX locations_city_idx ON locations (resolved_city);
-- The admin's geocoding queue: everything a human still needs to look at.
CREATE INDEX locations_needs_review_idx ON locations (accuracy)
  WHERE NOT national_service AND NOT location_accurate;


CREATE TABLE organizations (
  -- The Israeli registration number where one exists (amuta / company number),
  -- otherwise a source-prefixed id. Keeping the real number as the primary key
  -- is what lets records from different sources meet.
  id            text PRIMARY KEY,
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  short_name    text,
  -- עמותה, משרד ממשלתי, רשות מקומית, תאגיד סטטוטורי, … Feeds ranking.
  kind          text,
  purpose       text,
  description   text,
  urls          jsonb NOT NULL DEFAULT '[]'::jsonb,
  phone_numbers text[] NOT NULL DEFAULT '{}',
  email_address text,
  status        ssil_status NOT NULL DEFAULT 'draft',
  source_id     uuid,
  -- Identifiers this organization carries in other systems, keyed by source
  -- slug, so a second source can find it without guessing at the name.
  external_ids  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organizations_status_idx ON organizations (status);
CREATE INDEX organizations_kind_idx ON organizations (kind);
CREATE INDEX organizations_external_ids_idx ON organizations USING GIN (external_ids);


CREATE TABLE branches (
  id              text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  location_id     text REFERENCES locations (id) ON DELETE SET NULL,
  name            text,
  -- The unit inside the organization that runs this site, when it is named
  -- differently from the organization itself. Displayed instead of the
  -- organization name where present.
  operating_unit  text,
  description     text,
  address         text,
  address_details text,
  urls            jsonb NOT NULL DEFAULT '[]'::jsonb,
  phone_numbers   text[] NOT NULL DEFAULT '{}',
  email_address   text,
  status          ssil_status NOT NULL DEFAULT 'draft',
  source_id       uuid,
  external_ids    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX branches_organization_idx ON branches (organization_id);
CREATE INDEX branches_location_idx ON branches (location_id);
CREATE INDEX branches_status_idx ON branches (status);


CREATE TABLE services (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  description      text,
  -- Longer prose: eligibility, how to apply, opening hours in free text.
  details          text,
  payment_required boolean NOT NULL DEFAULT false,
  payment_details  text,
  urls             jsonb NOT NULL DEFAULT '[]'::jsonb,
  phone_numbers    text[] NOT NULL DEFAULT '{}',
  email_address    text,
  -- The government programme or tender this service delivers, free text.
  implements       text,
  -- Human-readable provenance shown on the card, e.g. a link to GuideStar.
  data_sources     text[] NOT NULL DEFAULT '{}',
  -- Editorial thumb on the scale. Enters ranking as a power of ten, so 1
  -- promotes a service by an order of magnitude and -1 buries it.
  boost            numeric NOT NULL DEFAULT 0,
  status           ssil_status NOT NULL DEFAULT 'draft',
  source_id        uuid,
  external_ids     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX services_status_idx ON services (status);
CREATE INDEX services_source_idx ON services (source_id);
CREATE INDEX services_external_ids_idx ON services USING GIN (external_ids);


CREATE TABLE service_branches (
  service_id text NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  branch_id  text NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, branch_id)
);

CREATE INDEX service_branches_branch_idx ON service_branches (branch_id);


CREATE TABLE service_organizations (
  service_id      text NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, organization_id)
);

CREATE INDEX service_organizations_org_idx ON service_organizations (organization_id);
