import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { query, transaction } from '@ssil/db';
import type { Axis } from '@ssil/core';

/**
 * Loads the openeligibility taxonomy into the database.
 *
 * The YAML is vendored in this repository rather than fetched at boot: the
 * taxonomy is the backbone of every filter and URL on the site, so an upstream
 * edit should arrive as a reviewed commit, not as a surprise during a restart.
 * Re-running is safe and picks up whatever the vendored file now says.
 */

const TAXONOMY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'taxonomy.tx.yaml',
);

/** The upstream file's own shape. Only these four keys ever appear. */
interface RawNode {
  name?: { source?: string; tx?: Record<string, string> };
  description?: { source?: string; tx?: Record<string, string> };
  slug?: string;
  pk?: string;
  items?: RawNode[];
}

interface FlatNode {
  id: string;
  axis: Axis;
  parentId: string | null;
  depth: number;
  pkUuid: string | null;
  sortOrder: number;
  names: { lang: string; name: string; description: string | null }[];
}

/**
 * The third axis, `human_places`, is present upstream but drives nothing here:
 * the card pipeline only ever tags services with responses and situations.
 * Loading it would put 22 nodes in the filter UI that can never match anything.
 */
const AXIS_BY_ROOT: Record<string, Axis> = {
  human_services: 'response',
  human_situations: 'situation',
};

export function flattenTaxonomy(roots: RawNode[]): FlatNode[] {
  const out: FlatNode[] = [];

  const walk = (node: RawNode, axis: Axis, parentId: string | null, depth: number, order: number) => {
    const id = node.slug;
    if (!id) return;

    const names: FlatNode['names'] = [];
    for (const [lang, name] of Object.entries(node.name?.tx ?? {})) {
      if (name) names.push({ lang, name, description: node.description?.tx?.[lang] ?? null });
    }
    // `source` is the English name; upstream keeps it outside the `tx` map.
    if (node.name?.source) {
      names.push({ lang: 'en', name: node.name.source, description: node.description?.source ?? null });
    }

    out.push({
      id,
      axis,
      parentId,
      depth,
      pkUuid: node.pk ?? null,
      sortOrder: order,
      names,
    });

    node.items?.forEach((child, i) => walk(child, axis, id, depth + 1, i));
  };

  roots.forEach((root) => {
    const axis = root.slug ? AXIS_BY_ROOT[root.slug] : undefined;
    if (!axis) return;
    // The root itself is skipped: "human_services" is the name of an axis, not
    // a category anyone would filter by.
    root.items?.forEach((child, i) => walk(child, axis, null, 0, i));
  });

  return out;
}

export async function loadTaxonomy(): Promise<{ nodes: number; names: number }> {
  const raw = parse(await readFile(TAXONOMY_FILE, 'utf8')) as RawNode[];
  const nodes = flattenTaxonomy(raw);

  await transaction(async (client) => {
    // Parents must exist before their children, and the file is already in
    // depth-first order, so inserting in order satisfies the foreign key.
    for (const n of nodes) {
      await client.query(
        `INSERT INTO taxonomy_nodes (id, axis, parent_id, depth, pk_uuid, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (id) DO UPDATE SET
           axis = EXCLUDED.axis,
           parent_id = EXCLUDED.parent_id,
           depth = EXCLUDED.depth,
           pk_uuid = EXCLUDED.pk_uuid,
           sort_order = EXCLUDED.sort_order,
           active = true,
           updated_at = now()`,
        [n.id, n.axis, n.parentId, n.depth, n.pkUuid, n.sortOrder],
      );
    }

    for (const n of nodes) {
      for (const nm of n.names) {
        await client.query(
          `INSERT INTO taxonomy_names (node_id, lang, name, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (node_id, lang) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description`,
          [n.id, nm.lang, nm.name, nm.description],
        );
      }
    }

    // A node that disappears upstream is deactivated rather than deleted: it
    // may still be referenced by a tag, a saved link or an indexed URL.
    const ids = nodes.map((n) => n.id);
    await client.query(
      `UPDATE taxonomy_nodes SET active = false, updated_at = now()
       WHERE NOT (id = ANY($1::text[])) AND active`,
      [ids],
    );

    await client.query('SELECT rebuild_taxonomy_closure()');
  });

  return {
    nodes: nodes.length,
    names: nodes.reduce((sum, n) => sum + n.names.length, 0),
  };
}

/** True when the taxonomy has never been loaded, so boot can seed it once. */
export async function taxonomyIsEmpty(): Promise<boolean> {
  const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM taxonomy_nodes');
  return (rows[0]?.n ?? 0) === 0;
}
