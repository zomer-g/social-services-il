import Anthropic from '@anthropic-ai/sdk';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { baseUrlOf, callRemoteTool, listServers, openSession } from '../mcpclient.js';
import {
  collect,
  loadCards,
  MODEL,
  overLimit,
  RequestSchema,
  type Interpretation,
} from './smart.js';

/**
 * Search across every registered MCP server.
 *
 * The difference from smart search is not the model or the prompt — it is where
 * the tools come from. Here they are discovered at request time by connecting to
 * each registered server and asking what it offers, so a corpus nobody wrote an
 * integration for becomes searchable the moment an administrator registers its
 * URL.
 *
 * With only this site's own server registered, the answers match smart search:
 * they are the same tools reached a longer way round, and it would be dishonest
 * to claim otherwise. The gain arrives with the second server. "Is this charity
 * still registered" is a question this corpus cannot answer and a government
 * registry can, and a service from a deregistered charity is a wrong answer we
 * currently have no way to detect.
 */
export const deepRouter: Router = Router();

deepRouter.post('/deep-search', (req: Request, res: Response) => {
  void handle(req, res).catch((err: Error) => {
    console.error('[error] deep search:', err.stack ?? err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

async function handle(req: Request, res: Response): Promise<void> {
  if (!config.anthropicApiKey) {
    res.status(503).json({
      error: 'smart_search_unavailable',
      message: 'החיפוש בכל המקורות אינו מוגדר בשרת. יש להגדיר ANTHROPIC_API_KEY.',
    });
    return;
  }

  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', message: 'q is required (2-500 characters)' });
    return;
  }
  if (overLimit(req.ip ?? 'unknown')) {
    res.status(429).json({
      error: 'rate_limited',
      message: 'יותר מדי חיפושים בשעה האחרונה. אפשר להשתמש בחיפוש הרגיל.',
    });
    return;
  }

  const { q, lat, lon, lang } = parsed.data;
  const session = await openSession(baseUrlOf(req));

  try {
    if (session.tools.length === 0) {
      res.status(503).json({
        error: 'no_sources',
        message: 'אף מקור מידע אינו זמין כרגע.',
        unavailable: session.failures,
      });
      return;
    }

    const tools: Anthropic.Tool[] = session.tools.map((tool) => ({
      name: tool.qualifiedName,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    // Each server describes itself; nobody here had to write that description,
    // which is the whole argument for the protocol.
    const system = [
      'You are helping someone find social services in Israel. They have typed a sentence about',
      'their situation rather than a category name.',
      '',
      'You have tools from several independent sources, each prefixed with its source name. The',
      'sources describe themselves below. Use the social services corpus to find services. Use any',
      'other source only where it adds something that corpus cannot answer on its own — for',
      'instance whether an organization is still registered — and do not let it slow the answer',
      'down when it has nothing to add.',
      '',
      session.instructions.join('\n\n'),
      '',
      'If the message suggests immediate danger, get the emergency numbers first and put them at',
      'the top of your answer.',
      '',
      'Reply with a short paragraph, three sentences at most, in the language the person wrote in.',
      'Say what you understood them to need and what you found, and mention anything a second',
      'source told you that changes the picture. Do not list the services: they are shown to the',
      'person as cards underneath. Do not invent a service, a phone number or an address.',
    ].join('\n');

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          lat !== undefined && lon !== undefined
            ? `${q}\n\n(The person's location is lat ${lat}, lon ${lon}. Pass it to the search.)`
            : q,
      },
    ];

    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const cardIds: string[] = [];
    const interpretation: Interpretation = { responses: [], situations: [] };
    const calls: string[] = [];
    let answer = '';

    // Slightly longer than smart search: more sources means more legitimate
    // steps, but a public endpoint still needs a ceiling.
    for (let turn = 0; turn < 8; turn += 1) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        output_config: { effort: 'low' },
        system,
        tools,
        messages,
      });

      if (response.stop_reason === 'refusal') {
        res.status(422).json({ error: 'declined', message: 'לא הצלחנו לעבד את הבקשה הזו.' });
        return;
      }

      for (const block of response.content) {
        if (block.type === 'text') answer += block.text;
      }
      if (response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        calls.push(block.name);
        try {
          const { text, structured } = await callRemoteTool(
            session.clients,
            block.name,
            (block.input ?? {}) as Record<string, unknown>,
          );
          // Card ids are mined only from this site's own server: another
          // server's identifiers mean nothing to our database, and treating
          // them as ours is how a page ends up showing something that is not
          // there.
          if (block.name.startsWith('local__') && structured) {
            collect(
              structured,
              block.name.slice('local__'.length),
              block.input,
              cardIds,
              interpretation,
            );
          }
          results.push({ type: 'tool_result', tool_use_id: block.id, content: text || '(no output)' });
        } catch (err) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: (err as Error).message,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    const cards = await loadCards(cardIds.slice(0, 20), lang, lat, lon);

    res.json({
      answer: answer.trim(),
      understood: interpretation,
      cards,
      tools_used: [...new Set(calls)],
      sources: [...session.clients.keys()],
      // Named rather than swallowed: an answer assembled from three sources
      // when four were asked is a different answer, and the person should be
      // able to see that.
      unavailable: session.failures,
    });
  } finally {
    await session.close();
  }
}

/** Which sources the site can search — drives the button and the admin. */
deepRouter.get('/sources', (_req, res) => {
  void listServers()
    .then((servers) =>
      res.set('Cache-Control', 'public, max-age=60').json({
        sources: servers.map((s) => ({ slug: s.slug, name: s.name, description: s.description })),
        // The second button is only worth showing when there is genuinely a
        // second corpus behind it. One source means it would duplicate the
        // smart search, and two buttons that do the same thing is worse than one.
        deep_search_useful: servers.length > 1,
        available: Boolean(config.anthropicApiKey),
      }),
    )
    .catch(() => res.json({ sources: [], deep_search_useful: false, available: false }));
});
