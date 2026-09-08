#!/usr/bin/env node
/** Writes the served spec to docs/openapi.json, so the repo carries a copy. */
import { writeFile } from 'node:fs/promises';
import { openapi } from '../packages/api/dist/openapi.js';

await writeFile('docs/openapi.json', `${JSON.stringify(openapi, null, 2)}\n`, 'utf8');
console.log(`docs/openapi.json written (${Object.keys(openapi.paths).length} paths)`);
