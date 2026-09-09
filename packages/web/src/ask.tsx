import { useRef, useState, type ReactNode } from 'react';
import { stringsFor, type Lang } from './i18n.js';

/**
 * Asking in your own words, answered in words.
 *
 * The ordinary search box needs the name of the thing. It returns a list of
 * cards, ranked, and the reading is left to the person: which of these forty
 * results is for me, does it cost anything, do I have to bring documents. This
 * panel takes a sentence — "אין לי כסף לאוכל ואני בירושלים" — and answers it in
 * prose, with the addresses and the phone numbers written into the answer.
 *
 * It sits underneath the ordinary search rather than replacing it, because the
 * two fail in opposite directions. The card search is exact, fast, and free; it
 * is the right thing when you know what you are looking for. This one costs a
 * model call and a few seconds, and it is the right thing when you do not know
 * what the thing you need is called — which is most people, most of the time.
 *
 * Everything it says comes back from the same MCP tools an outside assistant
 * would call. There is no second corpus and no separate ranking: if the answer
 * is wrong here, it is wrong through the API too, which is the property that
 * makes this worth having rather than a demo.
 */

interface AskResponse {
  answer: string;
  understood: { responses: { id: string; name: string }[]; situations: { id: string; name: string }[]; city?: string };
  cards: { card_id: string }[];
}

type State =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'answered'; answer: string; understood: AskResponse['understood'] }
  | { kind: 'failed'; message: string };

export function AskPanel({ lang, available }: { lang: Lang; available: boolean }) {
  const t = stringsFor(lang);
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  // Focus moves to the answer once it lands: a screen reader user who submits a
  // question and is left at the bottom of a form has no way to know anything
  // happened, and the live region alone reads it without letting them navigate
  // back through it.
  const answerRef = useRef<HTMLDivElement>(null);

  if (!available) return null;

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 2) return;
    setState({ kind: 'asking' });
    try {
      const res = await fetch('/api/v1/smart-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 'prose' is what makes this different from the card search: the
        // written answer is the result, so it carries the addresses itself.
        body: JSON.stringify({ q, lang, format: 'prose' }),
      });
      const body = (await res.json()) as AskResponse & { message?: string; error?: string };
      if (!res.ok) {
        setState({ kind: 'failed', message: body.message ?? t.askFailed });
        return;
      }
      if (!body.answer?.trim()) {
        setState({ kind: 'failed', message: t.askEmpty });
        return;
      }
      setState({ kind: 'answered', answer: body.answer, understood: body.understood });
      window.setTimeout(() => answerRef.current?.focus(), 0);
    } catch {
      setState({ kind: 'failed', message: t.askFailed });
    }
  }

  const busy = state.kind === 'asking';

  return (
    <section className="ask" aria-labelledby="ask-title">
      <h2 id="ask-title">{t.askTitle}</h2>
      <p className="ask-lead">{t.askLead}</p>

      <form onSubmit={ask}>
        <label htmlFor="ask-q" className="visually-hidden">
          {t.askLabel}
        </label>
        <textarea
          id="ask-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t.askPlaceholder}
          rows={3}
          maxLength={500}
          aria-describedby="ask-note"
          onKeyDown={(e) => {
            // Enter submits, as it does in the search box beside it; a newline
            // still available for anyone who wants to write more than a line.
            if (e.key === 'Enter' && !e.shiftKey) void ask(e as unknown as React.FormEvent);
          }}
        />
        <div className="ask-actions">
          <button type="submit" className="btn" disabled={busy || question.trim().length < 2}>
            {busy ? t.askWorking : t.askAction}
          </button>
          <p id="ask-note" className="hint">
            {t.askNote}
          </p>
        </div>
      </form>

      {/* One region, always present, so its content is announced when it
          changes rather than the region itself appearing and being missed. */}
      <div className="ask-answer" aria-live="polite" aria-busy={busy}>
        {busy && <p className="ask-working">{t.askWorking}</p>}

        {state.kind === 'failed' && (
          <p className="ask-error" role="alert">
            {state.message}
          </p>
        )}

        {state.kind === 'answered' && (
          <div ref={answerRef} tabIndex={-1} className="ask-prose">
            <Prose text={state.answer} />
            <Understood understood={state.understood} lang={lang} />
            <p className="ask-caveat">{t.askCaveat}</p>
          </div>
        )}
      </div>
    </section>
  );
}

/** What the search decided the sentence meant, so a wrong reading is visible. */
function Understood({ understood, lang }: { understood: AskResponse['understood']; lang: Lang }) {
  const t = stringsFor(lang);
  const tags = [...(understood?.responses ?? []), ...(understood?.situations ?? [])];
  if (tags.length === 0) return null;
  return (
    <p className="ask-understood">
      <span>{t.askUnderstood}</span>{' '}
      {tags.map((tag) => (
        <span key={tag.id} className="chip">
          {tag.name}
        </span>
      ))}
    </p>
  );
}

/**
 * Renders the model's answer as elements, never as HTML.
 *
 * The text comes from a language model, which means it is not trusted input in
 * the sense that matters here: setting it as innerHTML would make every service
 * description in the corpus a potential script. So this walks the small amount
 * of structure worth keeping — paragraphs, bullets, bold — and builds React
 * nodes. Anything it does not recognise stays as text, which is the safe way
 * for it to fail.
 */
function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);

  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const bulleted = lines.every((l) => /^\s*[-•*]\s+/.test(l));

        if (bulleted) {
          return (
            <ul key={i}>
              {lines.map((line, j) => (
                <li key={j}>{inline(line.replace(/^\s*[-•*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={i}>
            {lines.map((line, j) => (
              <span key={j}>
                {inline(line)}
                {j < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

/**
 * Bold, and phone numbers made dialable.
 *
 * The phone pattern is deliberately narrow. A number with a hyphen, a full
 * mobile or landline run of digits, a starred short code, or a hotline in the
 * 1xxx range — because the alternative, matching any run of three or four
 * digits, turns a house number into a telephone link and a year into a number
 * somebody might ring.
 */
const PHONE = /(\*\d{3,5}|\d{2,4}-\d{3}-?\d{4}|\d{2,3}-\d{6,7}|\b0\d{8,9}\b|\b1(?:-?\d{3}){1,2}-?\d{2,4}\b|\b1\d{2,3}\b)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;

  // Bold first, so a phone number inside **…** still becomes a link.
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) {
      out.push(<strong key={key++}>{linkPhones(bold[1] ?? '', () => key++)}</strong>);
    } else {
      out.push(...linkPhones(part, () => key++));
    }
  }
  return out;
}

function linkPhones(text: string, nextKey: () => number): ReactNode[] {
  const out: ReactNode[] = [];
  for (const piece of text.split(PHONE)) {
    if (!piece) continue;
    if (PHONE.test(piece) && piece.replace(/\D/g, '').length >= 3) {
      PHONE.lastIndex = 0;
      out.push(
        <a key={nextKey()} href={`tel:${piece.replace(/[^\d*+]/g, '')}`} className="tel">
          {piece}
        </a>,
      );
    } else {
      PHONE.lastIndex = 0;
      out.push(<span key={nextKey()}>{piece}</span>);
    }
  }
  return out;
}
