import fs from 'node:fs/promises';
import path from 'node:path';

import { createOpenApiDocument } from '../src/ria/openapi-document.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const output = path.join(projectRoot, 'openapi', 'ria.openapi.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`);
console.log(`RIA_OPENAPI_EXPORTED ${path.relative(projectRoot, output)}`);
