#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteJson } from '../src/ria/common.mjs';
import { RIA_SCHEMAS } from '../src/ria/schemas.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'schemas', 'ria');
await fs.mkdir(outputRoot, { recursive: true });
for (const [name, schema] of Object.entries(RIA_SCHEMAS)) {
    const filename = name === 'runManifest'
        ? 'run-manifest.schema.json'
        : `${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}.schema.json`;
    await atomicWriteJson(path.join(outputRoot, filename), schema);
}
process.stdout.write(`Exported ${Object.keys(RIA_SCHEMAS).length} RIA schemas to ${outputRoot}.\n`);
