import Anthropic from '@anthropic-ai/sdk';
import { MODELS, type Provider } from './models.js';

/**
 * Which catalog models each configured key can actually reach.
 *
 * A model id copied off a pricing page can be wrong, retired, or not enabled
 * for this account, and the first place to find that out should not be a
 * failed read of a real document. Each provider publishes the list of models a
 * key can use; this asks it, once, and says per model whether it is there.
 */

export interface ProviderCheck {
  configured: boolean;
  /** null when the provider was not asked (no key) or could not be asked. */
  reachable: boolean | null;
  error?: string | undefined;
  /** Catalog model id → whether the provider lists it for this key. */
  listed: Record<string, boolean>;
}

export async function verifyProviders(
  keys: Partial<Record<Provider, string>>,
): Promise<Record<Provider, ProviderCheck>> {
  const providers: Provider[] = ['anthropic', 'openai', 'google'];
  const checks = await Promise.all(providers.map((p) => check(p, keys[p])));
  return Object.fromEntries(providers.map((p, i) => [p, checks[i]!])) as Record<Provider, ProviderCheck>;
}

async function check(provider: Provider, key: string | undefined): Promise<ProviderCheck> {
  const catalog = MODELS.filter((m) => m.provider === provider).map((m) => m.id);
  if (!key) return { configured: false, reachable: null, listed: {} };

  try {
    const available = await list(provider, key);
    return {
      configured: true,
      reachable: true,
      listed: Object.fromEntries(catalog.map((id) => [id, available.has(id)])),
    };
  } catch (err) {
    return { configured: true, reachable: false, error: (err as Error).message.slice(0, 300), listed: {} };
  }
}

async function list(provider: Provider, key: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const signal = AbortSignal.timeout(15_000);

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: key, maxRetries: 1 });
    for await (const model of client.models.list({ limit: 1000 }, { signal })) ids.add(model.id);
    return ids;
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    for (const model of ((await res.json()) as { data?: { id: string }[] }).data ?? []) ids.add(model.id);
    return ids;
  }

  let pageToken = '';
  do {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': key }, signal });
    if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { models?: { name: string }[]; nextPageToken?: string };
    for (const model of body.models ?? []) ids.add(model.name.replace(/^models\//, ''));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return ids;
}
