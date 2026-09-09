-- 1,555 cards have a street address and no town.
--
-- They are the ones whose source said the city was the literal string
-- "unknown". Migration 012 stopped serving that word, correctly — announcing
-- "unknown" as the place to go is worse than saying nothing — but stopping
-- there left a card that reads:
--
--     תחכמוני 30 ירושלים        city: null
--
-- The town was never missing. It was written at the end of the address, where
-- nothing was looking for it. An assistant reading that card has a street but
-- no place to name, and cannot tell the person which town to travel to.
--
-- 1,276 of the 1,555 end with the name of a town this corpus already knows.
-- Those are recovered here. The remaining 279 either name no town or bury it
-- mid-string, and they are left alone: a street named after a place — הרצל,
-- עומר, מודיעין — is exactly how a rule that searched anywhere in the address
-- would start filing services under the wrong town, and a wrong town is worse
-- than none. Matching only the end, after a space, is the form that cannot do
-- that.
--
-- The longest candidate wins, so an address ending "מצפה רמון" is not filed
-- under "רמון".

CREATE OR REPLACE FUNCTION recover_cities_from_addresses() RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  WITH candidates AS (
    SELECT card_id, address
      FROM cards
     WHERE city IS NULL
       AND address IS NOT NULL
       AND NOT national_service
  ),
  best AS (
    SELECT DISTINCT ON (c.card_id) c.card_id, ci.city
      FROM candidates c
      JOIN city_index ci ON c.address LIKE '% ' || ci.city
     ORDER BY c.card_id, length(ci.city) DESC
  )
  UPDATE cards c
     SET city = b.city
    FROM best b
   WHERE c.card_id = b.card_id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

/**
 * The rebuild, with the recovery in it.
 *
 * Order matters and it is the whole reason this is one function rather than
 * three calls: the town list has to exist before addresses can be searched for
 * town names, and the towns recovered from addresses then belong in the list
 * themselves — a service that is the only one in its town would otherwise be
 * findable by nobody, because the resolver would never have heard of the place.
 * So the index is built, used, and built again.
 */
CREATE OR REPLACE FUNCTION rebuild_all() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  built integer;
BEGIN
  built := rebuild_cards();

  -- Apply the alias list to the data, so no card is left carrying a name the
  -- resolver will never answer with. See migration 019.
  UPDATE cards c
     SET city = ca.canonical
    FROM city_aliases ca
   WHERE ssil_city_key(c.city) = ca.alias_key
     AND c.city IS DISTINCT FROM ca.canonical;

  PERFORM rebuild_city_index();
  PERFORM recover_cities_from_addresses();
  PERFORM rebuild_city_index();

  RETURN built;
END;
$$;

INSERT INTO system_state (key, value)
VALUES ('cards_need_rebuild', 'recover the town from the address where the source said "unknown"')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
