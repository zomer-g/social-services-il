/** Runtime configuration, read once at boot. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const config = {
  /** The host probes GET / on this port and expects 2xx within 120s. */
  port: Number(process.env['XHOST_HTTP_PORT'] ?? process.env['PORT'] ?? 3000),
  env: process.env['NODE_ENV'] ?? 'production',
  /** Absent in local development, injected by the host in every deployed channel. */
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  publicUrl: process.env['PUBLIC_URL'] ?? '',
  /** Optional: enables LLM query understanding and tag suggestions. */
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
  required,
} as const;

export const hasDatabase = (): boolean => config.databaseUrl.length > 0;
