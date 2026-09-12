import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createServer } from '../../demo/lts-ui/node_modules/vite/dist/node/index.js';
import { getDemoCatalog, simulateSquadDemo } from '../../demo/demo-service.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const values = new Map();
const writes = [];
const memoryStorage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, String(value)); writes.push(key); },
    removeItem(key) { values.delete(key); writes.push(key); },
    clear() { values.clear(); },
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
};
// Node-only adapters: no real browser, storage database, network or listening port.
globalThis.window = { sessionStorage: memoryStorage, localStorage: memoryStorage,
    dispatchEvent: () => true, addEventListener() {}, removeEventListener() {},
    location: { origin: 'http://offline.invalid', hostname: 'offline.invalid' } };
globalThis.localStorage = memoryStorage;
globalThis.sessionStorage = memoryStorage;
const catalog = getDemoCatalog({ projectRoot: root });
const requests = [];
let rawResult;
globalThis.fetch = async (url, init) => {
    if (url === '/api/ake/catalog') return Response.json(catalog);
    if (url === '/api/ake/squad/simulate') {
        const input = JSON.parse(init.body);
        requests.push(input);
        rawResult = simulateSquadDemo(input, { projectRoot: root });
        return Response.json(rawResult);
    }
    throw new Error(`Unexpected network request in offline smoke: ${String(url)}`);
};
const server = await createServer({ root: resolve(root, 'demo/lts-ui'), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'error' });
try {
    const adapter = await server.ssrLoadModule('/src/integrations/ake/akeCatalogAdapter.ts');
    await adapter.installAkeCatalogData();
    const service = await server.ssrLoadModule('/src/core/services/timelineService.ts');
    const provider = await server.ssrLoadModule('/src/integrations/ake/akeProvider.ts');
    const realtime = await server.ssrLoadModule('/src/integrations/ake/akeRealtimeTimeline.ts');
    const ids = ['chr_0026_lastrite', 'chr_0027_tangtang'];
    const characters = ids.map(id => ({ id, name: catalog.characters.find(character => character.id === id).name }));
    const button = (id, lane, nodeIndex, skillType = 'B') => ({ id, characterId: ids[lane],
        characterName: characters[lane].name, nodeIndex, nodeNumber: nodeIndex + 1,
        staffIndex: lane, skillType, position: { x: 80 * nodeIndex, y: 0 } });
    const source = { ...button('S', 0, 0), releaseAnchor: { schemaVersion: 1, kind: 'group-start', debounceFrames: 20 } };
    const change = { ...button('X', 0, 1, 'Dot'), timelineModuleKind: 'operator-switch',
        operatorSwitchConfig: { schemaVersion: 1, targetCharacterId: ids[1] },
        releaseAnchor: { schemaVersion: 1, kind: 'group-start', debounceFrames: 20 } };
    const child = { ...button('C', 1, 0, 'A'), releaseAnchor: { schemaVersion: 1,
        kind: 'action-start', sourceButtonId: 'S', debounceFrames: 0 } };
    const data = { version: '1.2.0', createdAt: 1, updatedAt: 2,
        initialControllerCharacterId: ids[0], operationSequence: { schemaVersion: 1, operationIds: ['C', 'X', 'S'] },
        staffLines: [[source, change], [child]].map((buttons, staffIndex) => ({ staffIndex,
            characterName: characters[staffIndex].name, occupiedNodes: buttons.map(item => item.nodeIndex), buttons })) };
    values.set('def.timeline.data.v1', JSON.stringify(data));
    values.set('def.skill-button.v1', JSON.stringify(Object.fromEntries([source, change, child].map(item => [item.id, item]))));
    writes.length = 0;
    for (let count = 0; count < 2; count++) {
        assert.deepEqual(service.loadTimelineData(characters).operationSequence, data.operationSequence);
        assert.equal(service.ensureTimelineDataConsistency(characters).updatedAt, 2);
    }
    assert.equal(writes.length, 0, 'repeated service hydration must not write');
    assert.equal(values.get('def.timeline.data.v1'), JSON.stringify(data));
    const legacy = structuredClone(data);
    delete legacy.operationSequence;
    values.set('def.timeline.data.v1', JSON.stringify(legacy));
    const migrated = service.loadTimelineData(characters);
    assert.equal(migrated.operationSequence.schemaVersion, 1);
    assert.equal(migrated.updatedAt, 2);
    assert.equal(writes.length, 0, 'legacy migration must stay in memory');
    assert.equal(values.get('def.timeline.data.v1'), JSON.stringify(legacy));
    service.saveTimelineData(migrated, characters);
    assert.deepEqual(JSON.parse(values.get('def.timeline.data.v1')).operationSequence, migrated.operationSequence);
    assert.deepEqual(writes, ['def.timeline.data.v1'], 'explicit save writes the prepared sequence once');
    const preview = realtime.buildAkeRealtimeTimeline({ timelineData: data, selectedCharacters: characters, catalog, staffCount: 1 });
    assert.equal(preview.controlDispatch.C.controllerBefore, ids[1]);
    const record = [];
    const report = await provider.runAkeTeamCalculation({ timelineData: data, selectedCharacters: characters,
        riaActionSink: { record: event => { record.push(event.actionType); } } });
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.operationOrderVersion, 1);
    const operations = [...request.commands, ...request.operatorSwitches];
    assert.equal(operations.length, 3);
    assert.equal(new Set(operations.map(operation => operation.operationOrder)).size, 3);
    assert.ok(operations.every(operation => !Object.hasOwn(operation, 'timelineOrder')));
    assert.equal(report.summary.failedCommands, 0);
    assert.equal(report.summary.successfulCommands, 2);
    const result = { passed: true, serviceHydrationWrites: 0, explicitSequenceSaveWrites: 1,
        operationOrderVersion: request.operationOrderVersion,
        operationOrders: operations.map(operation => ({ id: operation.commandId ?? operation.switchId, order: operation.operationOrder })),
        previewControl: preview.controlDispatch,
        commands: rawResult.commands.map(command => ({ id: command.commandId, actualFrame: command.actualFrame, success: command.success })),
        controllerEvents: rawResult.controllerEvents, recordingEvents: record,
        scope: 'Synthetic UI input, real catalog/provider/demo/runner; service hydration only, no React effects or browser validation.' };
    writeFileSync(new URL('integration-smoke.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
} finally {
    await server.close();
}
