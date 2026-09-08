import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { query } from '@ssil/db';
import { CORPUS_INSTRUCTIONS, sharedTools } from './tools.js';

/**
 * MCP server for the social services corpus.
 *
 * The reason this exists: people increasingly ask an assistant rather than a
 * search box, and "where can my mother get a hot meal near Ramla" is exactly the
 * question this data answers and a general model cannot. Every tool here is
 * read-only and needs no credentials, because the underlying data is public and
 * the point of publishing it is that others can build on it.
 *
 * The tools themselves live in tools.ts and are shared with the site's own smart
 * search, so an assistant and the search box cannot answer the same question
 * differently.
 *
 * Each request gets its own server and transport. The corpus is stateless — no
 * session carries anything worth keeping between calls — and a per-request
 * instance means a hung client cannot hold resources.
 */

/** Results are rendered as text: an assistant relays them, it does not parse them. */
function asText(value: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'social-services-il', version: '1.0.0' },
    { instructions: CORPUS_INSTRUCTIONS },
  );

  for (const tool of sharedTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => asText(await tool.handler(args ?? {})),
    );
  }

  const taxonomyResource = (axis: 'response' | 'situation') => async (uri: URL) => {
    const { rows } = await query(
      `SELECT n.id, n.parent_id, nm.name, COALESCE(cc.card_count, 0) AS card_count
         FROM taxonomy_nodes n
         LEFT JOIN taxonomy_names nm ON nm.node_id = n.id AND nm.lang = 'he'
         LEFT JOIN taxonomy_card_counts cc ON cc.node_id = n.id
        WHERE n.active AND n.axis = $1::ssil_axis ORDER BY n.id`,
      [axis],
    );
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rows) }] };
  };

  server.registerResource(
    'taxonomy-responses',
    'taxonomy://responses',
    { title: 'Response taxonomy', description: 'What services provide.', mimeType: 'application/json' },
    taxonomyResource('response'),
  );

  server.registerResource(
    'taxonomy-situations',
    'taxonomy://situations',
    { title: 'Situation taxonomy', description: 'Who services are for.', mimeType: 'application/json' },
    taxonomyResource('situation'),
  );

  server.registerPrompt(
    'find-help',
    {
      title: 'Find help for a situation',
      description: 'Walk from a description of someone’s circumstances to concrete services they can contact.',
      argsSchema: {
        situation: z.string().describe('What the person is dealing with, in their own words.'),
        place: z.string().optional().describe('City or area, if known.'),
      },
    },
    ({ situation, place }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Someone needs help with: ${situation}`,
              place ? `They are in or near: ${place}` : 'Their location is unknown — ask, or include nationwide services.',
              '',
              'Please:',
              '1. If anything here suggests immediate danger, call emergency_lines first and give the number.',
              '2. Use find_taxonomy to turn this into response and situation ids.',
              '3. Use search_services with those ids and the location.',
              '4. Give at most five options. For each: what it is, who it is for, where, the phone number,',
              '   and when the record was last updated so they know to confirm.',
              '5. Say plainly if the corpus has little for this need, rather than padding the answer.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

/**
 * Handles one MCP request.
 *
 * Stateless: no session id, so nothing is retained between calls and any node
 * can serve any request. The corpus has no per-client state worth keeping.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[error] mcp request:', (err as Error).stack ?? (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}
