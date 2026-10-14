/**
 * Which of the cards a written answer actually names, in the order it names
 * them.
 *
 * The free-language box shows a person nothing but prose. The cards the model
 * fetched along the way are its working, not its answer: twenty of them came
 * back for "סלי מזון בירושלים" and the answer named six. Ranking the fetched
 * list would score services the person never saw, so the benchmark ranks what
 * was written instead.
 *
 * A card counts as named where the answer carries one of:
 *   - its phone number, however it is punctuated — the most specific signal,
 *     and the one the prose prompt insists on;
 *   - its service name;
 *   - its organization's name or short name, or the part before a dash
 *     ("מאיר פנים" for "מאיר פנים - מפעל חיים בע״מ") — but only when that
 *     organization has a single card among those fetched. "עיריית ירושלים"
 *     runs half of any Jerusalem list, and its name says which of them the
 *     answer meant no more than the city's name does.
 */

export interface MentionCard {
  card_id: string;
  service_name: string;
  organization_name: string;
  organization_short_name?: string | null;
  phone_numbers?: string[] | null;
}

/** The cards the answer names, ordered by where it first names them. */
export function orderByMention<T extends MentionCard>(answer: string, cards: T[]): T[] {
  const orgCount = new Map<string, number>();
  for (const card of cards) orgCount.set(card.organization_name, (orgCount.get(card.organization_name) ?? 0) + 1);

  const found: { card: T; at: number; order: number }[] = [];
  cards.forEach((card, order) => {
    const positions = [
      ...(card.phone_numbers ?? []).map((phone) => phoneAt(answer, phone)),
      textAt(answer, card.service_name),
      ...((orgCount.get(card.organization_name) ?? 0) === 1 ? orgNames(card).map((name) => textAt(answer, name)) : []),
    ].filter((at) => at >= 0);
    if (positions.length > 0) found.push({ card, at: Math.min(...positions), order });
  });

  // Two cards named at the same place (one phone serving two programmes) keep
  // the order they were fetched in.
  return found.sort((a, b) => a.at - b.at || a.order - b.order).map((f) => f.card);
}

function orgNames(card: MentionCard): string[] {
  const names = [card.organization_name, card.organization_short_name ?? ''];
  // The name before a dash or parenthesis is usually what prose calls it.
  const head = card.organization_name.split(/\s[-–—]\s|-\s|\s-|\(/)[0]?.trim() ?? '';
  names.push(head);
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))];
}

function textAt(answer: string, needle: string): number {
  const n = needle.trim();
  return n.length >= 3 ? answer.indexOf(n) : -1;
}

/** Finds a phone number written with any dashes, spaces or dots, or with +972 for the leading 0. */
function phoneAt(answer: string, phone: string): number {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  // Short numbers (an emergency line, a three-digit municipal hotline) are
  // shared by too many services to say which one was meant.
  if (digits.length < 4) return -1;
  const pattern = digits.split('').join('[\\s\\-–.]*');
  const match = new RegExp(`(?<!\\d)${pattern}(?!\\d)`).exec(answer);
  return match ? match.index : -1;
}
