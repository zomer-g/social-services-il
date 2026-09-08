/**
 * Hebrew text normalisation for search.
 *
 * Postgres ships no Hebrew stemmer, so every token we index or query is first
 * folded through here. The rules are deliberately conservative: over-stripping
 * turns distinct services into the same token, which is worse than missing a
 * prefix match (the trigram index catches those anyway).
 */

/** Niqqud, te'amim and the Hebrew punctuation marks that leak in from copy-paste. */
const DIACRITICS = /[\u0591-\u05C7]/g;
/** Geresh/gershayim, used inside acronyms such as עו"ס and צה"ל. */
const HEB_PUNCT = /[\u05F3\u05F4'"]/g;

/** Final forms mapped to their medial form, so סניף/סניפים fold together. */
const FINAL_FORMS: Record<string, string> = {
  '\u05DA': '\u05DB', // ך → כ
  '\u05DD': '\u05DE', // ם → מ
  '\u05DF': '\u05E0', // ן → נ
  '\u05E3': '\u05E4', // ף → פ
  '\u05E5': '\u05E6', // ץ → צ
};

/**
 * Single-letter particles (ו/ב/ל/כ/ה/מ/ש). Stripped only from tokens long
 * enough that the remainder is still a real word — otherwise "מזון" loses its
 * מ and collides with "זון".
 */
const PREFIXES = ['\u05D5', '\u05D1', '\u05DC', '\u05DB', '\u05D4', '\u05DE', '\u05E9'];
const MIN_LENGTH_AFTER_PREFIX = 3;

/**
 * Words that carry no discriminating power in this corpus: nearly every record
 * contains them. Taken from the stopword list the existing system strips.
 */
export const STOPWORDS = new Set([
  '\u05E2\u05DE\u05D5\u05EA\u05D4', // עמותה
  '\u05E9\u05D9\u05E8\u05D5\u05EA', // שירות
  '\u05E9\u05D9\u05E8\u05D5\u05EA\u05D9\u05DD', // שירותים
  '\u05EA\u05D5\u05DB\u05E0\u05D9\u05EA', // תוכנית
  '\u05D8\u05D9\u05E4\u05D5\u05DC', // טיפול
  '\u05E7\u05D1\u05D5\u05E6\u05D4', // קבוצה
  '\u05DE\u05E8\u05DB\u05D6', // מרכז
  '\u05D0\u05E8\u05D2\u05D5\u05DF', // ארגון
]);

export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(DIACRITICS, '').normalize('NFC');
}

export function foldFinalForms(text: string): string {
  return text.replace(/[\u05DA\u05DD\u05DF\u05E3\u05E5]/g, (c) => FINAL_FORMS[c] ?? c);
}

/** Strips one leading particle, but only when a usable stem remains. */
export function stripPrefix(token: string): string {
  const first = token[0];
  if (first === undefined || !PREFIXES.includes(first)) return token;
  const rest = token.slice(1);
  return rest.length >= MIN_LENGTH_AFTER_PREFIX ? rest : token;
}

export function tokenize(text: string): string[] {
  return stripDiacritics(text)
    .replace(HEB_PUNCT, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The canonical search form of a string: the tokens a document is indexed under
 * and a query is matched against.
 *
 * Each token yields two forms — as written, and with one leading particle
 * removed — because stripping is not reversible and we cannot tell a particle
 * from a root letter. "מזון" and "למזון" would otherwise reduce to different
 * tokens and never meet. Indexing both forms guarantees they overlap whichever
 * way the word was written.
 *
 * The authoritative implementation is ssil_normalize() in the database; this
 * mirrors it for client-side use, and the two are asserted equal in the tests.
 */
export function normalizeForSearch(text: string): string[] {
  const forms = new Set<string>();
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue;
    const folded = foldFinalForms(token);
    if (folded.length <= 1) continue;
    forms.add(folded);
    const stem = stripPrefix(folded);
    if (stem.length > 1) forms.add(stem);
  }
  return [...forms];
}

/** Is this string predominantly Hebrew? Decides which analyzer path to take. */
export function isHebrew(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const hebrew = letters.filter((c) => /[\u05D0-\u05EA]/.test(c)).length;
  return hebrew / letters.length > 0.5;
}
