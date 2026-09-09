-- The words somebody types are not the words the taxonomy uses.
--
-- "עזרה במילוי טפסים" — help filling in forms — returned one service, and it
-- was a melanoma charity's knowledge base that happened to contain all three
-- words. The corpus has 728 services for exactly this need, filed under
-- "מיצוי זכויות", and nothing in that node's text says "טפסים". The node
-- carried two synonyms; the word everyone actually uses was not one of them.
--
-- Same shape on the other side of the same report: "טיפול נפשי" is what a
-- parent says, and the 984-service node for it is named "טיפול רגשי
-- (פסיכולוגי)" with no synonyms at all. It was reachable only through services
-- that happened to spell it out in their own name.
--
-- Synonyms are the one lever in this system that turns a word into a whole
-- category of results, because ssil_tag_text folds them into every tagged
-- card's index. They are also the thing no upstream taxonomy will ever supply:
-- 237 of 431 nodes have none. This is a first pass over the gaps two people's
-- searches exposed, not a complete vocabulary.
INSERT INTO taxonomy_synonyms (node_id, lang, term)
SELECT v.node_id, 'he', v.term
FROM (VALUES
  -- Filling in a form, chasing a benefit, getting past a counter.
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'טפסים'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'מילוי טפסים'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'טופס'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'ניירת'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'הגשת בקשה'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'סיוע בירוקרטי'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'הנגשה בירוקרטית'),
  ('human_services:legal:advocacy_legal_aid:understand_government_programs', 'עזרה מול הרשויות'),

  -- What a person calls therapy, against what the tree calls it.
  ('human_services:health:mental_health_care:counseling', 'טיפול נפשי'),
  ('human_services:health:mental_health_care:counseling', 'טיפול פסיכולוגי'),
  ('human_services:health:mental_health_care:counseling', 'פסיכולוג'),
  ('human_services:health:mental_health_care:counseling', 'פסיכולוגית'),
  ('human_services:health:mental_health_care:counseling', 'פסיכותרפיה'),
  ('human_services:health:mental_health_care:counseling', 'מטפל רגשי'),
  ('human_services:health:mental_health_care:counseling', 'ייעוץ רגשי'),
  ('human_services:health:mental_health_care', 'טיפול נפשי'),
  ('human_services:health:mental_health_care', 'בריאות נפש'),
  ('human_services:health:mental_health_care', 'מצוקה נפשית'),
  ('human_services:health:mental_health_care:psychiatric_treatment', 'פסיכיאטר'),
  ('human_services:health:mental_health_care:psychiatric_treatment', 'פסיכיאטרי'),
  ('human_situations:mental_health', 'מצוקה נפשית'),
  ('human_situations:mental_health', 'קושי נפשי'),

  -- Ages, said the way people say them.
  ('human_situations:age_group:teens', 'מתבגרים'),
  ('human_situations:age_group:teens', 'מתבגרות'),
  ('human_situations:age_group:teens', 'בני נוער'),
  ('human_situations:age_group:teens', 'בנות נוער'),
  ('human_situations:age_group:children', 'ילד'),
  ('human_situations:age_group:children', 'ילדה')
) AS v(node_id, term)
-- A node that is not in this database yet is skipped rather than failing the
-- deploy: the tree is imported after migrations on a fresh channel.
JOIN taxonomy_nodes n ON n.id = v.node_id
ON CONFLICT DO NOTHING;

-- A synonym only reaches search once it has been folded into the cards, and
-- that happens in rebuild_cards(). Flagged rather than run here: the rebuild
-- outlasts the platform's health check, and the server does it after it is
-- already serving.
INSERT INTO system_state (key, value) VALUES ('cards_need_rebuild', 'new taxonomy synonyms')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
