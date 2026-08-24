import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializablePelicaModel } from '../src/scenarios/pelica.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(projectRoot, 'derived', 'cleanroom', 'pelica-model.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(serializablePelicaModel(), null, 2)}\n`, 'utf8');
console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
