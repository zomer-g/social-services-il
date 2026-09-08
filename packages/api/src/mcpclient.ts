import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { query } from '@ssil/db';
import { config } from './config.js';

/**
 * The site as an MCP client.
 *
 * This is what lets the search reach a corpus nobody here has written an
 * integration for: an MCP server is a contract that describes its own tools, so
 * a registered URL is enough.
 *
 * Tool names are namespaced by server slug, because two servers will eventually
 * both offer something called `search`, and a collision would silently route a
 * question to the wrong corpus.
 */

export interface RegisteredServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  description: string | null;
  auth_header: string | null;
  enabled: boolean;
  is_self: boolean;
}

export interface RemoteTool {
  /** `slug__toolname` — what the model sees. */
  qualifiedName: string;
  toolName: string;
  server: RegisteredServer;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SEPARATOR = '__';
/** A server that has not answered by now is not going to rescue the search. */
const CONNECT_TIMEOUT_MS = 8000;

/** `self` means this instance; resolved at call time so it follows the host. */
function resolveUrl(server: RegisteredServer, baseUrl: string): string {
  return server.url === 'self' ? `${baseUrl}/mcp` : server.url;
}

export async function listServers(onlyEnabled = true): Promise<RegisteredServer[]> {
  const { rows } = await query<RegisteredServer>(
    `SELECT id, slug, name, url, description, auth_header, enabled, is_self
       FROM mcp_servers
      ${onlyEnabled ? 'WHERE enabled' : ''}
      ORDER BY is_self DESC, name`,
  );
  return rows;
}

async function connect(server: RegisteredServer, baseUrl: string): Promise<Client> {
  const client = new Client({ name: 'social-services-il-site', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resolveUrl(server, baseUrl)), {
    requestInit: server.auth_header ? { headers: { authorization: server.auth_header } } : undefined,
  });

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to ${server.slug}`);
  return client;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out ${what}`)), ms).unref()),
  ]);
}

/**
 * Opens a session against every enabled server and collects their tools.
 *
 * One server being down must not take the search with it: a failure is recorded
 * and the rest carry on. Losing one source degrades the answer; losing all of
 * them because one timed out loses it entirely.
 */
export async function openSession(baseUrl: string): Promise<{
  tools: RemoteTool[];
  clients: Map<string, Client>;
  instructions: string[];
  failures: { server: string; error: string }[];
  close: () => Promise<void>;
}> {
  const servers = await listServers();
  const clients = new Map<string, Client>();
  const tools: RemoteTool[] = [];
  const instructions: string[] = [];
  const failures: { server: string; error: string }[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        const client = await connect(server, baseUrl);
        clients.set(server.slug, client);

        const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing ${server.slug}`);
        for (const tool of listed.tools) {
          tools.push({
            qualifiedName: `${server.slug}${SEPARATOR}${tool.name}`,
            toolName: tool.name,
            server,
            description: `[${server.name}] ${tool.description ?? ''}`.trim(),
            inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          });
        }

        // A server's own instructions describe how it expects to be used, which
        // is exactly what the model needs and what nobody here had to write.
        const own = client.getInstructions();
        if (own) instructions.push(`## ${server.name}\n${own}`);
        else if (server.description) instructions.push(`## ${server.name}\n${server.description}`);
      } catch (err) {
        failures.push({ server: server.slug, error: (err as Error).message });
        console.error(`[warn] mcp server ${server.slug} unavailable:`, (err as Error).message);
      }
    }),
  );

  return {
    tools,
    clients,
    instructions,
    failures,
    close: async () => {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
}

/** Runs one tool call, routed back to the server that owns it. */
export async function callRemoteTool(
  clients: Map<string, Client>,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: unknown }> {
  const index = qualifiedName.indexOf(SEPARATOR);
  const slug = qualifiedName.slice(0, index);
  const toolName = qualifiedName.slice(index + SEPARATOR.length);

  const client = clients.get(slug);
  if (!client) throw new Error(`No connection to server "${slug}"`);

  const result = await withTimeout(
    client.callTool({ name: toolName, arguments: args }),
    30_000,
    `calling ${qualifiedName}`,
  );

  const text = (result.content as { type: string; text?: string }[] | undefined)
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n') ?? '';

  // The text is what the model reads; the parsed form is what the site mines
  // for real card ids.
  let structured: unknown = result.structuredContent ?? null;
  if (structured === null && text.startsWith('{')) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = null;
    }
  }

  return { text, structured };
}

/** Connects, lists tools, and records the outcome. Needs no model credentials. */
export async function testServer(id: string, baseUrl: string): Promise<{
  ok: boolean;
  tools: string[];
  error?: string;
}> {
  const { rows } = await query<RegisteredServer>(
    `SELECT id, slug, name, url, description, auth_header, enabled, is_self
       FROM mcp_servers WHERE id = $1`,
    [id],
  );
  const server = rows[0];
  if (!server) return { ok: false, tools: [], error: 'no such server' };

  try {
    const client = await connect(server, baseUrl);
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'listing tools');
    await client.close().catch(() => {});
    const names = listed.tools.map((t) => t.name);

    await query(
      `UPDATE mcp_servers SET last_checked_at = now(), last_status = 'ok', tool_count = $2 WHERE id = $1`,
      [id, names.length],
    );
    return { ok: true, tools: names };
  } catch (err) {
    const message = (err as Error).message;
    await query(
      `UPDATE mcp_servers SET last_checked_at = now(), last_status = $2, tool_count = NULL WHERE id = $1`,
      [id, message.slice(0, 300)],
    );
    return { ok: false, tools: [], error: message };
  }
}

export function baseUrlOf(req: { protocol: string; get: (h: string) => string | undefined }): string {
  return config.publicUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}
