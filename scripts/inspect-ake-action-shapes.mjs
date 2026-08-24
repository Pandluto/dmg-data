import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { actionType } from '../src/core/ake-parser.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const requested = new Set(process.argv.slice(2).filter(argument => argument !== '--full'));
if (requested.size === 0) {
    throw new Error('Pass one or more short serialized action type names.');
}

const directories = [
    path.join(projectRoot, 'reference', 'public-data', 'akedata', 'Json', 'BuffData'),
    path.join(projectRoot, 'reference', 'public-data', 'akedata', 'Json', 'SkillData')
];
const results = Object.fromEntries([...requested].map(type => [type, []]));
const omittedKeys = new Set([
    'advancedDirection', 'effectData', 'hitSoundData', 'selectorData',
    'validatorData', 'postProcessorData'
]);

function compact(value, depth = 0) {
    if (full || value === null || typeof value !== 'object') return value;
    if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).join(',')}}`;
    if (Array.isArray(value)) {
        const items = value.slice(0, 3).map(item => compact(item, depth + 1));
        if (value.length > items.length) items.push(`[+${value.length - items.length} items]`);
        return items;
    }
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !omittedKeys.has(key))
        .map(([key, child]) => [key, compact(child, depth + 1)]));
}

function visit(value, location) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${location}[${index}]`));
        return;
    }
    const type = actionType(value.$type);
    if (requested.has(type) && results[type].length < 3) {
        results[type].push({ location, value: compact(value) });
    }
    for (const [key, child] of Object.entries(value)) {
        if (key !== '$type') visit(child, `${location}.${key}`);
    }
}

for (const directory of directories) {
    const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
    for (const file of files) {
        if ([...requested].every(type => results[type].length >= 3)) break;
        const document = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
        visit(document, `${path.relative(projectRoot, path.join(directory, file)).replaceAll('\\', '/')}:$`);
    }
}

console.log(JSON.stringify(results, null, 2));
