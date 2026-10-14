import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderByMention, type MentionCard } from './mentions.js';

/**
 * Cases taken from a real free-language answer to "סלי מזון בירושלים": twenty
 * cards fetched, six services named, and a municipality running half the list.
 */

const card = (id: string, service: string, org: string, phones: string[] = []): MentionCard => ({
  card_id: id,
  service_name: service,
  organization_name: org,
  phone_numbers: phones,
});

const ids = (cards: MentionCard[]) => cards.map((c) => c.card_id);

describe('orderByMention', () => {
  it('orders by first mention and drops cards the answer never names', () => {
    const cards = [
      card('welfare', 'תמיכה וייעוץ', 'משרד הרווחה', ['02-5457930']),
      card('street', 'יחידה לטיפול בדרי רחוב', 'עיריית ירושלים', ['02-6297720']),
      card('elderly', 'מרכז יום לאזרחים ותיקים', 'עיריית ירושלים', ['02-6297720']),
      card('meir', 'מסעדות לנזקקים', 'מאיר פנים - מפעל חיים בע"מ', ['025011400']),
      card('haya', 'סלי מזון היו שלום', 'היו שלום', ['0556697988']),
    ];
    const answer = [
      '**עמותת היו שלום – סלי מזון**',
      'טלפון: 055-6697988.',
      '**מסעדות מאיר פנים**',
      'המחלקה לשירותים חברתיים (עיריית ירושלים / משרד הרווחה): 02-5457930.',
    ].join('\n');
    assert.deepEqual(ids(orderByMention(answer, cards)), ['haya', 'meir', 'welfare']);
  });

  it('does not let a shared organization name stand for every card it runs', () => {
    const cards = [
      card('a', 'ארוחות חמות לאזרחים ותיקים', 'עיריית ירושלים'),
      card('b', 'טיפת חלב', 'עיריית ירושלים'),
    ];
    assert.deepEqual(ids(orderByMention('פנו לעיריית ירושלים.', cards)), []);
    assert.deepEqual(ids(orderByMention('יש גם טיפת חלב בשכונה.', cards)), ['b']);
  });

  it('reads a phone written with +972, spaces or a star code', () => {
    const cards = [
      card('intl', 'שירות א', 'ארגון א', ['+972-3-6281155']),
      card('star', 'שירות ב', 'ארגון ב', ['*3656']),
    ];
    assert.deepEqual(ids(orderByMention('מוקד 3656* או 03 628 1155', cards)), ['star', 'intl']);
  });

  it('ignores numbers too short to say which service was meant', () => {
    assert.deepEqual(ids(orderByMention('חייגו 118', [card('x', 'שירות', 'ארגון רב סניפים', ['118']), card('y', 'שירות', 'ארגון רב סניפים', ['118'])])), []);
  });

  it('does not match a phone inside a longer number', () => {
    assert.deepEqual(ids(orderByMention('ת.ז. 1025004222', [card('k', 'שירות', 'ארגון', ['025004222'])])), []);
  });
});
