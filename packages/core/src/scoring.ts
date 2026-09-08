/**
 * Card ranking.
 *
 * This mirrors the multiplicative heuristic the existing system uses, because
 * it encodes real editorial judgement: without it results are dominated by
 * one-branch organisations with empty descriptions. Kept as plain arithmetic so
 * the same numbers can be reproduced in SQL during a card rebuild.
 */

export interface ScoreInput {
  hasDescription: boolean;
  nationalService: boolean;
  /** A short or 1-800 number signals a staffed hotline rather than a desk phone. */
  phoneNumbers: string[];
  organizationKind?: string | null;
  organizationBranchCount: number;
  /** Editorial override, applied as 10**boost. */
  boost: number;
}

/** Organisation kinds that carry statutory backing, and so a reliability bonus. */
const AUTHORITATIVE_KINDS = new Set([
  '\u05DE\u05E9\u05E8\u05D3 \u05DE\u05DE\u05E9\u05DC\u05EA\u05D9', // משרד ממשלתי
  '\u05E8\u05E9\u05D5\u05EA \u05DE\u05E7\u05D5\u05DE\u05D9\u05EA', // רשות מקומית
  '\u05EA\u05D0\u05D2\u05D9\u05D3 \u05E1\u05D8\u05D8\u05D5\u05D8\u05D5\u05E8\u05D9', // תאגיד סטטוטורי
]);

/** A hotline: either very short, or a 1-800/1-700 style prefix. */
export function isHotline(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 6 || digits.startsWith('1');
}

export function cardScore(input: ScoreInput): number {
  let score = 1;

  // A service with no description cannot be acted on, so it ranks below one that can.
  if (input.hasDescription) score *= 10;

  if (input.nationalService) {
    score *= 10;
    if (input.phoneNumbers.some(isHotline)) score *= 5;
  } else {
    // Reach as a proxy for capacity, damped so a 500-branch chain cannot bury
    // the single local organisation that actually serves this neighbourhood.
    const branches = Math.max(1, input.organizationBranchCount);
    score *= branches > 100 ? branches / 10 : Math.sqrt(branches);
  }

  if (input.organizationKind && AUTHORITATIVE_KINDS.has(input.organizationKind)) score *= 5;

  return score * Math.pow(10, input.boost);
}

/**
 * Key used to collapse the same service offered through many organisations
 * into one result. Without it a nationwide food programme floods the page.
 */
export function collapseKey(serviceName: string, serviceDescription?: string | null): string {
  return `${serviceName} ${serviceDescription ?? ''}`.trim().replace(/\s+/g, ' ');
}
