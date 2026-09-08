-- MCP servers the site itself can search.
--
-- The point of this table is that adding a data source stops being a code
-- change. An MCP server is a contract — here are my tools, here is what they
-- do — so a search that speaks the protocol can reach a new corpus the moment
-- someone registers its URL, without anyone writing an integration for it.
--
-- Our own server is registered here too. Reaching it over HTTP rather than
-- calling the same functions in process buys nothing on its own; it is here so
-- that the local corpus and an external one are searched by exactly the same
-- mechanism, and so the site is a real client of the contract it publishes —
-- if the MCP surface breaks, the site's own search breaks, which is a far
-- louder signal than a test going red.

CREATE TABLE mcp_servers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL
              CHECK (slug ~ '^[a-z][a-z0-9_]{0,30}$'),
  name        text NOT NULL,
  url         text NOT NULL,
  -- Shown to the person choosing whether to search this source, and given to
  -- the model so it knows what the server is for.
  description text,
  -- Some servers need a credential. Stored as a whole header value so a server
  -- that wants something other than a bearer token still works.
  auth_header text,
  enabled     boolean NOT NULL DEFAULT true,
  -- Our own server, which must not be deleted from the admin by accident.
  is_self     boolean NOT NULL DEFAULT false,

  -- Filled in by a connection test, so the admin can see whether a server is
  -- actually reachable rather than only that someone typed a URL.
  last_checked_at timestamptz,
  last_status     text,
  tool_count      int,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mcp_servers_enabled_idx ON mcp_servers (enabled);

-- The site's own server. The URL is resolved at boot from PUBLIC_URL, so a
-- placeholder here is replaced rather than trusted.
INSERT INTO mcp_servers (slug, name, url, description, is_self, enabled)
VALUES (
  'local',
  'שירותים חברתיים — המאגר של האתר',
  'self',
  'The social services corpus this site publishes: services, organizations, branches and the two taxonomy axes.',
  true,
  true
)
ON CONFLICT (slug) DO NOTHING;

-- Registered but switched off: it needs a credential, and a server that 401s on
-- every search is worse than one that is plainly not connected yet.
INSERT INTO mcp_servers (slug, name, url, description, enabled)
VALUES (
  'over',
  'גרסאות לעם — מאגרי ממשלה',
  'https://www.over.org.il/mcp',
  'Israeli government open data with version history, including the registry of nonprofits and public-benefit companies. Useful for checking whether an organization is still registered and active.',
  false
)
ON CONFLICT (slug) DO NOTHING;
