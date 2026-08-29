import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { RiaArchive } from '../src/ria/archive.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const uiRoot = path.join(projectRoot, 'demo', 'lts-ui');
const uiRequire = createRequire(path.join(uiRoot, 'package.json'));
const { chromium } = uiRequire('@playwright/test');

function providerInput(runId, enemyId = 'eny_0007_mimicw') {
    return { runId, enemyId };
}

async function invokeRealProvider(page, { caseId, sessionId, runId, enemyId }) {
    return page.evaluate(async context => {
        sessionStorage.setItem('def.ria.active-run.v1', JSON.stringify({
            caseId: context.caseId,
            sessionId: context.sessionId,
            runId: context.runId
        }));
        const { runAkeTeamCalculation } = await import(
            '/src/integrations/ake/akeProvider.ts'
        );
        const character = { id: 'chr_0004_pelica', name: '佩丽卡' };
        const button = {
            id: `${context.runId}-pelica-b`,
            characterId: character.id,
            characterName: character.name,
            skillType: 'B',
            staffIndex: 0,
            nodeIndex: 0,
            nodeNumber: 1,
            position: { x: 0, y: 0 }
        };
        try {
            const report = await runAkeTeamCalculation({
                timelineData: {
                    version: 'ria-provider-e2e',
                    createdAt: 0,
                    updatedAt: 0,
                    staffLines: [{
                        staffIndex: 0,
                        characterName: character.name,
                        occupiedNodes: [0],
                        buttons: [button]
                    }]
                },
                selectedCharacters: [character],
                enemyId: context.enemyId,
                executionDigest: `provider-e2e:${context.runId}`
            });
            return {
                ok: true,
                commandId: report.timeline.commands[0]?.commandId ?? null,
                totalDamage: report.summary.totalDamage,
                durationFrames: report.durationFrames
            };
        } catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }, { caseId, sessionId, runId, enemyId });
}

test('real Chromium akeProvider records same-origin actions on its exact calculation Run', async t => {
    const keepArchive = process.env.RIA_UI_E2E_KEEP === '1';
    const archiveRoot = process.env.RIA_UI_E2E_ARCHIVE_ROOT
        ? path.resolve(process.env.RIA_UI_E2E_ARCHIVE_ROOT)
        : await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-ui-provider-'));
    const caseId = process.env.RIA_UI_E2E_CASE_ID ?? 'case-ui-provider-e2e';
    const sessionId = process.env.RIA_UI_E2E_SESSION_ID ?? 'session-ui-provider-e2e';
    const successRunId = process.env.RIA_UI_E2E_RUN_ID ?? 'run-ui-provider-completed';
    const failedRunId = `${successRunId}-failed`;
    if (!keepArchive) t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));

    const archive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
    await archive.createCase({ caseId, title: 'Real akeProvider HTTP evidence' });
    await archive.createSession({ caseId, sessionId, summary: 'Chromium provider bridge' });

    const previousArchiveRoot = process.env.RIA_ARCHIVE_ROOT;
    const previousFailureRunId = process.env.RIA_UI_E2E_FAIL_DELIVERY_RUN_ID;
    process.env.RIA_ARCHIVE_ROOT = archiveRoot;
    process.env.RIA_UI_E2E_FAIL_DELIVERY_RUN_ID = failedRunId;
    t.after(() => {
        if (previousArchiveRoot === undefined) delete process.env.RIA_ARCHIVE_ROOT;
        else process.env.RIA_ARCHIVE_ROOT = previousArchiveRoot;
        if (previousFailureRunId === undefined) delete process.env.RIA_UI_E2E_FAIL_DELIVERY_RUN_ID;
        else process.env.RIA_UI_E2E_FAIL_DELIVERY_RUN_ID = previousFailureRunId;
    });

    const viteEntry = uiRequire.resolve('vite');
    const { createServer } = await import(pathToFileURL(viteEntry).href);
    const vite = await createServer({
        configFile: path.join(uiRoot, 'vite.config.ts'),
        logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, strictPort: false }
    });
    await vite.listen();
    t.after(() => vite.close());
    const viteAddress = vite.httpServer.address();
    assert.ok(viteAddress && typeof viteAddress === 'object');
    const origin = `http://127.0.0.1:${viteAddress.port}`;

    const browserExecutables = [
        chromium.executablePath(),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium'
    ];
    const executablePath = browserExecutables.find(candidate => fsSync.existsSync(candidate));
    assert.ok(executablePath, 'Chromium or Google Chrome is required for the real browser test.');
    const browser = await chromium.launch({
        headless: true,
        executablePath
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const uiActionRequests = [];
    page.on('request', request => {
        if (request.url().includes('/api/ria/runs/')
            && request.url().includes('/ui-actions')) {
            uiActionRequests.push({
                url: request.url(),
                method: request.method(),
                payload: request.postDataJSON()
            });
        }
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    const success = await invokeRealProvider(page, {
        caseId,
        sessionId,
        ...providerInput(successRunId)
    });
    assert.equal(success.ok, true, success.message);
    assert.equal(success.commandId, `${successRunId}-pelica-b`);

    const [manifest, fixture, events, uiActions] = await Promise.all([
        archive.getRun(successRunId, caseId),
        archive.readRunArtifact(successRunId, 'fixture', caseId),
        archive.readRunArtifact(successRunId, 'events', caseId),
        archive.readRunArtifact(successRunId, 'uiActions', caseId)
    ]);
    assert.equal(manifest.sealed, true);
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.config.uiCalculation, true);
    assert.equal(manifest.counts.uiActions, 2);
    assert.equal(fixture.input.commands[0].commandId, success.commandId);
    assert.ok(events.some(event => event.commandId === success.commandId));
    assert.deepEqual(uiActions.map(action => action.actionType), [
        'AkeCalculationRequested',
        'AkeCalculationCompleted'
    ]);
    assert.ok(uiActions.every(action => action.actor === 'lts-ui'));
    assert.equal(uiActions[0].payload.commandCount, 1);
    assert.deepEqual(uiActions[0].payload.selectedCharacterIds, ['chr_0004_pelica']);
    assert.equal(uiActions[1].payload.totalDamage, success.totalDamage);
    assert.equal(uiActions[1].frame, success.durationFrames);
    assert.deepEqual(
        uiActionRequests.slice(0, 2).map(request => ({
            origin: new URL(request.url).origin,
            method: request.method,
            actionType: request.payload.actionType
        })),
        [
            { origin, method: 'POST', actionType: 'AkeCalculationRequested' },
            { origin, method: 'POST', actionType: 'AkeCalculationCompleted' }
        ]
    );

    const late = await page.evaluate(async ({ caseId: lateCaseId, runId }) => {
        const response = await fetch(
            `/api/ria/runs/${encodeURIComponent(runId)}/ui-actions?caseId=${encodeURIComponent(lateCaseId)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actionType: 'LateUiAction', actor: 'lts-ui' })
            }
        );
        return { status: response.status, body: await response.json() };
    }, { caseId, runId: successRunId });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'RIA_RUN_SEALED');
    assert.equal((await archive.readRunArtifact(successRunId, 'uiActions', caseId)).length, 2);

    if (process.env.RIA_UI_E2E_SUCCESS_ONLY === '1') return;

    const failed = await invokeRealProvider(page, {
        caseId,
        sessionId,
        ...providerInput(failedRunId)
    });
    assert.equal(failed.ok, false);
    const [failedManifest, failedActions] = await Promise.all([
        archive.getRun(failedRunId, caseId),
        archive.readRunArtifact(failedRunId, 'uiActions', caseId)
    ]);
    assert.equal(failedManifest.sealed, true);
    assert.equal(failedManifest.status, 'completed');
    assert.deepEqual(failedActions.map(action => action.actionType), [
        'AkeCalculationRequested',
        'AkeCalculationFailed'
    ]);
    assert.equal(failedActions[1].payload.status, 502);
});
