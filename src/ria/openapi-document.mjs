import { RIA_SCHEMAS } from './schemas.mjs';

function component(schema) {
    const copy = structuredClone(schema);
    delete copy.$schema;
    delete copy.$id;
    return copy;
}

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = schema => ({
    'application/json': { schema: typeof schema === 'string' ? ref(schema) : schema }
});
const jsonResponse = (description, schema) => ({ description, content: jsonContent(schema) });
const requestBody = schema => ({ required: true, content: jsonContent(schema) });

const errorResponses = {
    400: { $ref: '#/components/responses/BadRequest' },
    404: { $ref: '#/components/responses/NotFound' },
    409: { $ref: '#/components/responses/Conflict' },
    413: { $ref: '#/components/responses/PayloadTooLarge' },
    500: { $ref: '#/components/responses/InternalError' }
};

const parameters = {
    CaseId: {
        name: 'caseId', in: 'path', required: true, schema: ref('ArchiveId')
    },
    SessionId: {
        name: 'sessionId', in: 'path', required: true, schema: ref('ArchiveId')
    },
    RunId: {
        name: 'runId', in: 'path', required: true, schema: ref('ArchiveId')
    },
    CaseIdQuery: { name: 'caseId', in: 'query', schema: ref('ArchiveId') },
    AfterSequence: {
        name: 'afterSequence', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 }
    },
    Limit: {
        name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
    }
};

const schemas = {
    ArchiveId: {
        type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$',
        minLength: 1, maxLength: 96
    },
    JsonValue: {
        oneOf: [
            { type: 'null' },
            { type: 'boolean' },
            { type: 'number' },
            { type: 'string' },
            { type: 'array', items: ref('JsonValue') },
            { type: 'object', additionalProperties: ref('JsonValue') }
        ]
    },
    Case: component(RIA_SCHEMAS.case),
    CaseCreateRequest: component(RIA_SCHEMAS.caseCreateRequest),
    CaseCloseRequest: component(RIA_SCHEMAS.caseCloseRequest),
    Session: component(RIA_SCHEMAS.session),
    SessionCreateBody: component(RIA_SCHEMAS.sessionCreateBody),
    SessionEntry: component(RIA_SCHEMAS.sessionEntry),
    SessionEntryAppendRequest: component(RIA_SCHEMAS.sessionEntryAppendRequest),
    RunManifest: component(RIA_SCHEMAS.runManifest),
    Event: component(RIA_SCHEMAS.event),
    Snapshot: component(RIA_SCHEMAS.snapshot),
    ReplayRequest: component(RIA_SCHEMAS.replayRequest),
    UiActionAppendRequest: component(RIA_SCHEMAS.uiActionAppendRequest),
    Error: component(RIA_SCHEMAS.errorResponse),
    SseReady: {
        type: 'object', additionalProperties: false,
        required: ['runId', 'afterSequence', 'waitingForRun'],
        properties: {
            runId: ref('ArchiveId'),
            afterSequence: { type: 'integer', minimum: 0 },
            waitingForRun: { type: 'boolean' }
        }
    },
    SseTerminal: {
        type: 'object', additionalProperties: false,
        required: ['runId', 'status', 'lastSequence'],
        properties: {
            runId: ref('ArchiveId'),
            status: { enum: ['completed', 'interrupted', 'partial', 'failed'] },
            lastSequence: { type: 'integer', minimum: 0 }
        }
    },
    SseError: component(RIA_SCHEMAS.errorResponse),
    CaseList: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: { items: { type: 'array', items: ref('Case') } }
    },
    SessionList: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: { items: { type: 'array', items: ref('Session') } }
    },
    RunList: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: { items: { type: 'array', items: ref('RunManifest') } }
    },
    Page: {
        type: 'object', additionalProperties: false,
        required: ['afterSequence', 'limit', 'nextAfterSequence', 'hasMore'],
        properties: {
            afterSequence: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 1000 },
            nextAfterSequence: { type: 'integer', minimum: 0 },
            nextCursor: { type: 'string', minLength: 1 },
            readCursor: { type: 'string', minLength: 1 },
            hasMore: { type: 'boolean' },
            diagnostics: {
                type: 'object', additionalProperties: false,
                required: [
                    'strategy', 'indexStride', 'indexRebuilt', 'indexExtended',
                    'seekSequence', 'startOffset', 'endOffset', 'fileBytes',
                    'bytesScanned', 'recordsDecoded', 'trailingBytes'
                ],
                properties: {
                    strategy: { enum: ['sparse-sequence-byte-offset', 'gzip-sequential-decompression'] },
                    indexStride: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
                    indexRebuilt: { type: 'boolean' },
                    indexExtended: { type: 'boolean' },
                    seekSequence: { type: 'integer', minimum: 1 },
                    startOffset: { type: 'integer', minimum: 0 },
                    endOffset: { type: 'integer', minimum: 0 },
                    fileBytes: { type: 'integer', minimum: 0 },
                    bytesScanned: { type: 'integer', minimum: 0 },
                    recordsDecoded: { type: 'integer', minimum: 0 },
                    trailingBytes: { type: 'integer', minimum: 0 }
                }
            }
        }
    },
    EventPage: {
        type: 'object', additionalProperties: false, required: ['items', 'page'],
        properties: { items: { type: 'array', items: ref('Event') }, page: ref('Page') }
    },
    SessionEntryPage: {
        type: 'object', additionalProperties: false, required: ['items', 'page'],
        properties: {
            items: { type: 'array', items: ref('SessionEntry') },
            page: {
                type: 'object', additionalProperties: false,
                required: ['afterSequence', 'limit', 'nextAfterSequence', 'hasMore'],
                properties: {
                    afterSequence: { type: 'integer', minimum: 0 },
                    limit: { type: 'integer', minimum: 1, maximum: 1000 },
                    nextAfterSequence: { type: 'integer', minimum: 0 },
                    hasMore: { type: 'boolean' }
                }
            }
        }
    },
    StateProof: {
        type: 'object', additionalProperties: false,
        required: [
            'exact', 'reason', 'snapshotSequence', 'snapshotFrame',
            'eventSequenceFrom', 'eventSequenceTo'
        ],
        properties: {
            exact: { type: 'boolean' },
            reason: { enum: [
                'EXACT_FACT_FRAME', 'LAST_PROVABLE_STATE_BEFORE_FRAME',
                'NO_SNAPSHOT_AT_OR_BEFORE_FRAME'
            ] },
            snapshotSequence: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            snapshotFrame: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
            eventSequenceFrom: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            eventSequenceTo: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }
        }
    },
    StateResponse: {
        type: 'object', additionalProperties: false, required: ['frame', 'state', 'proof'],
        properties: {
            frame: { type: 'number', minimum: 0 },
            state: { type: 'object', additionalProperties: true },
            proof: ref('StateProof')
        }
    },
    ReplayAccepted: {
        type: 'object', additionalProperties: false,
        required: ['accepted', 'sourceRunId', 'replayRunId', 'statusUrl', 'streamUrl'],
        properties: {
            accepted: { const: true },
            sourceRunId: ref('ArchiveId'),
            replayRunId: ref('ArchiveId'),
            statusUrl: { type: 'string', minLength: 1 },
            streamUrl: { type: 'string', minLength: 1 }
        }
    },
    ReplayJob: {
        type: 'object', additionalProperties: false,
        required: [
            'replayRunId', 'sourceRunId', 'status', 'startedAt', 'result', 'error'
        ],
        properties: {
            replayRunId: ref('ArchiveId'),
            sourceRunId: ref('ArchiveId'),
            status: { enum: ['running', 'completed', 'failed'] },
            startedAt: { type: 'string', format: 'date-time' },
            endedAt: { type: 'string', format: 'date-time' },
            result: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
            error: { anyOf: [
                {
                    type: 'object', additionalProperties: false,
                    required: ['code', 'message', 'runId'],
                    properties: {
                        code: { type: 'string' }, message: { type: 'string' },
                        runId: { anyOf: [ref('ArchiveId'), { type: 'null' }] }
                    }
                },
                { type: 'null' }
            ] }
        }
    },
    Diff: {
        type: 'object', additionalProperties: false,
        required: [
            'schemaVersion', 'leftRunId', 'rightRunId', 'fixture', 'environment',
            'eventsIdentical', 'resultsIdentical', 'firstDivergence'
        ],
        properties: {
            schemaVersion: { const: 1 },
            leftRunId: ref('ArchiveId'),
            rightRunId: ref('ArchiveId'),
            fixture: {
                type: 'object', additionalProperties: false,
                required: ['identical', 'leftHash', 'rightHash'],
                properties: {
                    identical: { type: 'boolean' },
                    leftHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                    rightHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }
                }
            },
            environment: {
                type: 'object', additionalProperties: true,
                required: ['identical', 'reasons', 'left', 'right', 'leftVersions', 'rightVersions'],
                properties: {
                    identical: { type: 'boolean' },
                    reasons: { type: 'array', items: { type: 'string' } },
                    left: { type: 'object' }, right: { type: 'object' },
                    leftVersions: { type: 'object' }, rightVersions: { type: 'object' }
                }
            },
            eventsIdentical: { type: 'boolean' },
            resultsIdentical: { type: 'boolean' },
            firstDivergence: {
                type: 'object', additionalProperties: false,
                required: ['identical', 'index', 'left', 'right', 'context', 'kind'],
                properties: {
                    identical: { type: 'boolean' },
                    index: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
                    left: {}, right: {}, context: {},
                    kind: { anyOf: [{ enum: ['event', 'result'] }, { type: 'null' }] }
                }
            }
        }
    },
    UiActionAccepted: {
        type: 'object', additionalProperties: false,
        required: ['accepted', 'runId', 'sequence'],
        properties: {
            accepted: { const: true }, runId: ref('ArchiveId'),
            sequence: { type: 'integer', minimum: 1 }
        }
    },
    Health: {
        type: 'object', additionalProperties: false,
        required: ['ok', 'service', 'schemaVersion', 'bind', 'activeReplayJobs'],
        properties: {
            ok: { const: true }, service: { const: 'replayable-investigation-archive' },
            schemaVersion: { const: 1 }, bind: { type: 'string' },
            activeReplayJobs: { type: 'integer', minimum: 0 }
        }
    },
    Capabilities: {
        type: 'object', additionalProperties: true,
        required: [
            'schemaVersion', 'archiveAuthority', 'replayAdapters', 'eventFilters',
            'realtime', 'pagination', 'limits', 'security'
        ],
        properties: {
            schemaVersion: { const: 1 },
            archiveAuthority: { const: 'append-only-sealed-runs' },
            replayAdapters: { type: 'array', items: { type: 'string' } },
            eventFilters: { type: 'array', items: { type: 'string' } },
            realtime: { type: 'object' }, pagination: { type: 'object' },
            limits: { type: 'object' }, security: { type: 'object' }
        }
    },
    SchemaDocument: {
        type: 'object', additionalProperties: false,
        required: ['schemaVersion', 'validator', 'schemas', 'eventAuthority'],
        properties: {
            schemaVersion: { const: 1 }, validator: { type: 'object' },
            schemas: { type: 'object' }, eventAuthority: { type: 'object' }
        }
    },
    OpenApiDocument: {
        type: 'object', additionalProperties: true,
        required: ['openapi', 'info', 'paths', 'components'],
        properties: {
            openapi: { type: 'string', pattern: '^3\\.1\\.' },
            info: { type: 'object' }, paths: { type: 'object' }, components: { type: 'object' }
        }
    },
    Artifact: {
        anyOf: [
            ref('RunManifest'),
            { type: 'array', items: ref('Event') },
            { type: 'array', items: ref('Snapshot') },
            { type: 'array', items: ref('JsonValue') },
            { type: 'object', additionalProperties: ref('JsonValue') },
            { type: 'string' }
        ]
    }
};

function operation({ operationId, parameters: operationParameters = [], request = null, success }) {
    return {
        operationId,
        parameters: operationParameters,
        ...(request ? { requestBody: requestBody(request) } : {}),
        responses: { ...success, ...errorResponses }
    };
}

export function createOpenApiDocument() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'Replayable Investigation Archive API',
            version: '1.1.0',
            description: 'Local append-only calculation evidence, worker replay, cursor paging and SSE.'
        },
        servers: [{ url: 'http://127.0.0.1:43822' }],
        paths: {
            '/api/ria/health': { get: operation({
                operationId: 'getHealth', success: { 200: jsonResponse('Health', 'Health') }
            }) },
            '/api/ria/schema': { get: operation({
                operationId: 'getSchemas', success: { 200: jsonResponse('Schemas', 'SchemaDocument') }
            }) },
            '/api/ria/capabilities': { get: operation({
                operationId: 'getCapabilities', success: { 200: jsonResponse('Capabilities', 'Capabilities') }
            }) },
            '/api/ria/openapi.json': { get: operation({
                operationId: 'getOpenApi', success: { 200: jsonResponse('OpenAPI', 'OpenApiDocument') }
            }) },
            '/api/ria/cases': {
                get: operation({ operationId: 'listCases', success: { 200: jsonResponse('Cases', 'CaseList') } }),
                post: operation({
                    operationId: 'createCase', request: 'CaseCreateRequest',
                    success: { 201: jsonResponse('Created Case', 'Case') }
                })
            },
            '/api/ria/cases/{caseId}': { get: operation({
                operationId: 'getCase', parameters: [parameters.CaseId],
                success: { 200: jsonResponse('Case', 'Case') }
            }) },
            '/api/ria/cases/{caseId}/close': { post: operation({
                operationId: 'closeCase', parameters: [parameters.CaseId], request: 'CaseCloseRequest',
                success: { 200: jsonResponse('Closed Case', 'Case') }
            }) },
            '/api/ria/cases/{caseId}/sessions': {
                get: operation({
                    operationId: 'listSessions', parameters: [parameters.CaseId],
                    success: { 200: jsonResponse('Sessions', 'SessionList') }
                }),
                post: operation({
                    operationId: 'createSession', parameters: [parameters.CaseId],
                    request: 'SessionCreateBody', success: { 201: jsonResponse('Session', 'Session') }
                })
            },
            '/api/ria/cases/{caseId}/sessions/{sessionId}': { get: operation({
                operationId: 'getSession', parameters: [parameters.CaseId, parameters.SessionId],
                success: { 200: jsonResponse('Session', 'Session') }
            }) },
            '/api/ria/cases/{caseId}/sessions/{sessionId}/entries': {
                get: operation({
                    operationId: 'listSessionEntries',
                    parameters: [parameters.CaseId, parameters.SessionId, parameters.AfterSequence, parameters.Limit, {
                        name: 'type', in: 'query', schema: { type: 'string' }
                    }],
                    success: { 200: jsonResponse('Session entries', 'SessionEntryPage') }
                }),
                post: operation({
                    operationId: 'appendSessionEntry',
                    parameters: [parameters.CaseId, parameters.SessionId],
                    request: 'SessionEntryAppendRequest',
                    success: { 201: jsonResponse('Session entry', 'SessionEntry') }
                })
            },
            '/api/ria/runs': { get: operation({
                operationId: 'listRuns', parameters: [parameters.CaseIdQuery, {
                    name: 'sessionId', in: 'query', schema: ref('ArchiveId')
                }, { name: 'status', in: 'query', schema: { type: 'string' } }],
                success: { 200: jsonResponse('Runs', 'RunList') }
            }) },
            '/api/ria/runs/{runId}': { get: operation({
                operationId: 'getRun', parameters: [parameters.RunId, parameters.CaseIdQuery],
                success: { 200: jsonResponse('Run', 'RunManifest') }
            }) },
            '/api/ria/runs/{runId}/events': { get: operation({
                operationId: 'queryEvents',
                parameters: [
                    parameters.RunId, parameters.CaseIdQuery, parameters.AfterSequence, parameters.Limit,
                    { name: 'cursor', in: 'query', schema: { type: 'string' } },
                    { name: 'fromFrame', in: 'query', schema: { type: 'number', minimum: 0 } },
                    { name: 'toFrame', in: 'query', schema: { type: 'number', minimum: 0 } },
                    ...['eventType', 'actorId', 'targetId', 'rootCastId', 'childCastId'].map(name => ({
                        name, in: 'query', schema: { type: 'string' }
                    }))
                ],
                success: { 200: jsonResponse('Event page', 'EventPage') }
            }) },
            '/api/ria/runs/{runId}/state': { get: operation({
                operationId: 'getStateAtFrame',
                parameters: [parameters.RunId, parameters.CaseIdQuery, {
                    name: 'frame', in: 'query', required: true, schema: { type: 'number', minimum: 0 }
                }],
                success: { 200: jsonResponse('Provable state', 'StateResponse') }
            }) },
            '/api/ria/runs/{runId}/stream': { get: {
                operationId: 'streamRunEvents',
                parameters: [parameters.RunId, parameters.CaseIdQuery, parameters.AfterSequence, {
                    name: 'Last-Event-ID', in: 'header', schema: { type: 'integer', minimum: 0 }
                }],
                responses: {
                    200: {
                        description: 'SSE stream. ria-event uses Event; terminal events use SseTerminal.',
                        content: { 'text/event-stream': { schema: { type: 'string' } } },
                        'x-sse-events': [
                            { event: 'stream-ready', payload: ref('SseReady') },
                            { event: 'ria-event', id: 'Event.sequence', payload: ref('Event') },
                            { event: 'run-complete', payload: ref('SseTerminal') },
                            { event: 'run-interrupted', payload: ref('SseTerminal') },
                            { event: 'stream-error', payload: ref('SseError') }
                        ]
                    },
                    ...errorResponses
                }
            } },
            '/api/ria/runs/{runId}/replay': { post: operation({
                operationId: 'replayRun', parameters: [parameters.RunId, parameters.CaseIdQuery],
                request: 'ReplayRequest', success: { 202: jsonResponse('Replay accepted', 'ReplayAccepted') }
            }) },
            '/api/ria/runs/{runId}/ui-actions': {
                post: operation({
                    operationId: 'appendUiAction', parameters: [parameters.RunId, parameters.CaseIdQuery, {
                        name: 'Origin', in: 'header', schema: { type: 'string', format: 'uri' }
                    }],
                    request: 'UiActionAppendRequest',
                    success: {
                        202: jsonResponse('UI action accepted', 'UiActionAccepted'),
                        403: jsonResponse('Untrusted browser origin', 'Error')
                    }
                }),
                options: operation({
                    operationId: 'preflightUiAction',
                    parameters: [parameters.RunId, parameters.CaseIdQuery, {
                        name: 'Origin', in: 'header', required: true,
                        schema: { type: 'string', format: 'uri' }
                    }, {
                        name: 'Access-Control-Request-Method', in: 'header', required: true,
                        schema: { const: 'POST' }
                    }, {
                        name: 'Access-Control-Request-Headers', in: 'header', required: true,
                        schema: { const: 'content-type' }
                    }],
                    success: {
                        204: {
                            description: 'Trusted loopback UI origin accepted.',
                            headers: {
                                'Access-Control-Allow-Origin': { schema: { type: 'string', format: 'uri' } },
                                'Access-Control-Allow-Methods': { schema: { const: 'POST' } },
                                'Access-Control-Allow-Headers': { schema: { const: 'Content-Type' } },
                                Vary: { schema: { const: 'Origin' } }
                            }
                        },
                        403: jsonResponse('Untrusted or malformed preflight', 'Error')
                    }
                })
            },
            '/api/ria/runs/{runId}/{artifact}': { get: operation({
                operationId: 'getRunArtifact',
                parameters: [parameters.RunId, parameters.CaseIdQuery, {
                    name: 'artifact', in: 'path', required: true,
                    schema: { enum: [
                        'manifest', 'fixture', 'commands', 'snapshots', 'assertions',
                        'result', 'ui-actions', 'findings'
                    ] }
                }],
                success: { 200: jsonResponse('Run artifact', 'Artifact') }
            }) },
            '/api/ria/jobs/{jobId}': { get: operation({
                operationId: 'getReplayJob', parameters: [{
                    name: 'jobId', in: 'path', required: true, schema: ref('ArchiveId')
                }], success: { 200: jsonResponse('Replay job', 'ReplayJob') }
            }) },
            '/api/ria/diff': { get: operation({
                operationId: 'diffRuns', parameters: [
                    { name: 'leftRunId', in: 'query', required: true, schema: ref('ArchiveId') },
                    { name: 'rightRunId', in: 'query', required: true, schema: ref('ArchiveId') },
                    { name: 'leftCaseId', in: 'query', schema: ref('ArchiveId') },
                    { name: 'rightCaseId', in: 'query', schema: ref('ArchiveId') }
                ], success: { 200: jsonResponse('Normalized diff', 'Diff') }
            }) }
        },
        components: {
            schemas,
            responses: {
                BadRequest: jsonResponse('Bad request', 'Error'),
                NotFound: jsonResponse('Not found', 'Error'),
                Conflict: jsonResponse('Conflict', 'Error'),
                PayloadTooLarge: jsonResponse('Payload too large', 'Error'),
                InternalError: jsonResponse('Internal error', 'Error')
            }
        }
    };
}

export default createOpenApiDocument;
