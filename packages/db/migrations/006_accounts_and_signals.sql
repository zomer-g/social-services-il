-- Accounts, API keys, and the signals the site collects back from use.
--
-- Note what is absent: the public site needs no account at all. Someone looking
-- for a food parcel should not have to register, and a shelter search should
-- not be attached to an identity. Saved lists are keyed by an unguessable token
-- held in the browser, and search logging records the query, never the searcher.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text,
  picture_url   text,
  -- Google's stable subject id. Email can change; this does not.
  google_sub    text UNIQUE,
  role          text NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('admin', 'editor', 'tagger', 'org_manager', 'viewer')),
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Access is invitation-only: an unknown Google account that signs in is
-- rejected rather than created, so the admin cannot be reached by anyone who
-- happens to find its URL.
CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  role       text NOT NULL DEFAULT 'viewer'
             CHECK (role IN ('admin', 'editor', 'tagger', 'org_manager', 'viewer')),
  -- Set for an org_manager, scoping them to their own organization's services.
  organization_id text REFERENCES organizations (id) ON DELETE CASCADE,
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  token      text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invites_pending_email_idx ON invites (lower(email))
  WHERE accepted_at IS NULL;


CREATE TABLE org_memberships (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'manager' CHECK (role IN ('manager', 'contributor')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);


CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  -- Only the hash is stored: a leaked database must not yield working keys.
  key_hash     text UNIQUE NOT NULL,
  -- The first characters of the key, shown in the UI so an owner can tell their
  -- keys apart without the platform being able to reconstruct one.
  key_prefix   text NOT NULL,
  -- e.g. {'read', 'ingest:write'}.
  scopes       text[] NOT NULL DEFAULT '{read}',
  -- A writing key belongs to a source: everything it pushes is attributed there,
  -- and inherits that source's trust level.
  source_id    uuid REFERENCES sources (id) ON DELETE CASCADE,
  organization_id text REFERENCES organizations (id) ON DELETE CASCADE,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  rate_limit_per_hour int NOT NULL DEFAULT 1000,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_source_idx ON api_keys (source_id);


-- "My folder": services someone kept, so they can come back to them or hand
-- them to somebody else. No account, no email — just a token in the browser and
-- a shareable link, which is also how a social worker sends a shortlist to a client.
CREATE TABLE saved_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unguessable; the URL is the credential.
  token        text UNIQUE NOT NULL,
  title        text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Abandoned lists are swept, so the table does not become a permanent record
  -- of what strangers were looking for.
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '180 days'
);

CREATE TABLE saved_list_items (
  list_id    uuid NOT NULL REFERENCES saved_lists (id) ON DELETE CASCADE,
  card_id    text NOT NULL,
  note       text,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, card_id)
);


CREATE TABLE feedback_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     text,
  service_id  text,
  kind        text NOT NULL DEFAULT 'error'
              CHECK (kind IN ('error', 'closed', 'wrong_phone', 'wrong_address', 'other')),
  message     text NOT NULL,
  -- Optional, and only if the reporter offers it so we can follow up.
  contact     text,
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'acknowledged', 'fixed', 'rejected')),
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_reports_open_idx ON feedback_reports (status, created_at DESC);


-- What people looked for and whether they found anything.
--
-- Deliberately not tied to a person or a session: the point is to learn which
-- needs the corpus cannot answer, not who has them. A run of searches for
-- something that returns nothing is the single most useful signal the admin
-- gets about what to go and collect next.
CREATE TABLE search_events (
  id            bigserial PRIMARY KEY,
  query         text,
  normalized    text,
  response_ids  text[] NOT NULL DEFAULT '{}',
  situation_ids text[] NOT NULL DEFAULT '{}',
  city          text,
  has_location  boolean NOT NULL DEFAULT false,
  lang          text NOT NULL DEFAULT 'he',
  result_count  int NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_events_zero_idx ON search_events (at DESC) WHERE result_count = 0;
CREATE INDEX search_events_normalized_idx ON search_events (normalized);
