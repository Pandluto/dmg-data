import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { hashJson, RIA_ID_PATTERN, RIA_SCHEMA_VERSION, RiaInputError } from './common.mjs';

const idSchema = {
    type: 'string',
    pattern: RIA_ID_PATTERN.source,
    minLength: 1,
    maxLength: 96
};
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const dateTimeSchema = { type: 'string', format: 'date-time' };
const domainIdSchema = {
    anyOf: [
        { type: 'string', minLength: 1, maxLength: 512 },
        { type: 'number' }
    ]
};
const nullableDomainIdSchema = { anyOf: [domainIdSchema, { type: 'null' }] };
const nullableTextSchema = maxLength => ({
    anyOf: [{ type: 'string', maxLength }, { type: 'null' }]
});
const jsonObjectSchema = { type: 'object', additionalProperties: true };

const policySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        retentionDays: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        maxRuns: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        compression: { enum: ['none', 'gzip'] }
    }
};

export const CASE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/case.schema.json',
    title: 'RIA Case',
    type: 'object',
    additionalProperties: false,
    required: [
        'schemaVersion', 'caseId', 'title', 'description', 'status', 'createdAt',
        'updatedAt', 'closedAt', 'tags', 'policy'
    ],
    properties: {
        schemaVersion: { const: RIA_SCHEMA_VERSION },
        caseId: idSchema,
        title: { type: 'string', minLength: 1, maxLength: 240 },
        description: { type: 'string', maxLength: 20_000 },
        status: { enum: ['open', 'closed'] },
        createdAt: dateTimeSchema,
        updatedAt: dateTimeSchema,
        closedAt: { anyOf: [dateTimeSchema, { type: 'null' }] },
        resolution: { type: 'string', maxLength: 20_000 },
        tags: {
            type: 'array', maxItems: 64, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 80 }
        },
        policy: policySchema
    }
};

export const CASE_CREATE_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/case-create-request.schema.json',
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
        caseId: idSchema,
        title: { type: 'string', minLength: 1, maxLength: 240 },
        description: { type: 'string', maxLength: 20_000 },
        tags: {
            type: 'array', maxItems: 64, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 80 }
        },
        policy: policySchema
    }
};

export const CASE_CLOSE_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/case-close-request.schema.json',
    type: 'object', additionalProperties: false,
    properties: { resolution: { type: 'string', maxLength: 20_000 } }
};

export const SESSION_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/session.schema.json',
    title: 'RIA Session Manifest',
    type: 'object',
    additionalProperties: false,
    required: [
        'schemaVersion', 'caseId', 'sessionId', 'createdAt', 'summary', 'actor', 'metadata'
    ],
    properties: {
        schemaVersion: { const: RIA_SCHEMA_VERSION },
        caseId: idSchema,
        sessionId: idSchema,
        createdAt: dateTimeSchema,
        summary: { type: 'string', maxLength: 10_000 },
        actor: { type: 'string', minLength: 1, maxLength: 160 },
        metadata: jsonObjectSchema
    }
};

export const SESSION_CREATE_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/session-create-request.schema.json',
    type: 'object', additionalProperties: false, required: ['caseId'],
    properties: {
        caseId: idSchema,
        sessionId: idSchema,
        summary: { type: 'string', maxLength: 10_000 },
        actor: { type: 'string', minLength: 1, maxLength: 160 },
        metadata: jsonObjectSchema
    }
};

export const SESSION_CREATE_BODY_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/session-create-body.schema.json',
    type: 'object', additionalProperties: false,
    properties: {
        sessionId: idSchema,
        summary: { type: 'string', maxLength: 10_000 },
        actor: { type: 'string', minLength: 1, maxLength: 160 },
        metadata: jsonObjectSchema
    }
};

const sessionEntryProperties = {
    schemaVersion: { const: RIA_SCHEMA_VERSION },
    caseId: idSchema,
    sessionId: idSchema,
    sequence: { type: 'integer', minimum: 1 },
    createdAt: dateTimeSchema,
    type: { enum: ['decision', 'finding', 'run-link', 'commit-link', 'thread-link', 'note'] },
    actor: { type: 'string', minLength: 1, maxLength: 160 },
    content: { type: 'string', minLength: 1, maxLength: 20_000 },
    runId: idSchema,
    relatedRunId: idSchema,
    relation: { type: 'string', minLength: 1, maxLength: 80 },
    commit: { type: 'string', minLength: 1, maxLength: 160 },
    threadId: { type: 'string', minLength: 1, maxLength: 240 },
    threadSource: { type: 'string', minLength: 1, maxLength: 160 },
    metadata: jsonObjectSchema,
    contentHash: hashSchema
};
const sessionEntryConditionals = [
    {
        if: { properties: { type: { const: 'run-link' } }, required: ['type'] },
        then: { required: ['runId'] }
    },
    {
        if: { properties: { type: { const: 'commit-link' } }, required: ['type'] },
        then: { required: ['commit'] }
    },
    {
        if: { properties: { type: { const: 'thread-link' } }, required: ['type'] },
        then: { required: ['threadId', 'threadSource'] }
    }
];

export const SESSION_ENTRY_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/session-entry.schema.json',
    title: 'RIA Session Journal Entry',
    type: 'object', additionalProperties: false,
    required: [
        'schemaVersion', 'caseId', 'sessionId', 'sequence', 'createdAt',
        'type', 'actor', 'content', 'metadata', 'contentHash'
    ],
    properties: sessionEntryProperties,
    allOf: sessionEntryConditionals
};

export const SESSION_ENTRY_APPEND_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/session-entry-append-request.schema.json',
    type: 'object', additionalProperties: false, required: ['type', 'content'],
    properties: Object.fromEntries(Object.entries(sessionEntryProperties).filter(([key]) => ![
        'schemaVersion', 'caseId', 'sessionId', 'sequence', 'createdAt', 'contentHash'
    ].includes(key))),
    allOf: sessionEntryConditionals
};

const changedPathSchema = {
    type: 'object', additionalProperties: false, required: ['status', 'path'],
    properties: {
        status: { type: 'string', minLength: 1, maxLength: 8 },
        path: { type: 'string', minLength: 1, maxLength: 4096 }
    }
};
const untrackedExecutionFileSchema = {
    type: 'object', additionalProperties: false, required: ['path', 'sha256'],
    properties: { path: { type: 'string', minLength: 1 }, sha256: hashSchema }
};
const environmentSchema = {
    type: 'object', additionalProperties: false, required: ['node', 'platform', 'arch', 'git'],
    properties: {
        node: { type: 'string', minLength: 1 },
        platform: { type: 'string', minLength: 1 },
        arch: { type: 'string', minLength: 1 },
        git: {
            type: 'object', additionalProperties: false,
            required: [
                'commit', 'branch', 'dirty', 'changedPathCount', 'changedPaths',
                'statusHash', 'trackedDiffHash', 'truncatedChangedPaths'
            ],
            properties: {
                commit: { type: 'string', minLength: 1 },
                branch: { type: 'string', minLength: 1 },
                dirty: { type: 'boolean' },
                changedPathCount: { type: 'integer', minimum: 0 },
                changedPaths: { type: 'array', maxItems: 500, items: changedPathSchema },
                statusHash: hashSchema,
                trackedDiffHash: hashSchema,
                truncatedChangedPaths: { type: 'boolean' },
                untrackedExecutionFiles: {
                    type: 'array', maxItems: 1000, items: untrackedExecutionFileSchema
                },
                untrackedExecutionHash: hashSchema
            }
        }
    }
};
const versionsSchema = {
    type: 'object', additionalProperties: false,
    required: ['rulesHash', 'dataHash', 'archiveSchemaVersion'],
    properties: {
        rulesHash: hashSchema,
        dataHash: hashSchema,
        executableHash: hashSchema,
        recorderHash: hashSchema,
        archiveSchemaVersion: { const: RIA_SCHEMA_VERSION },
        engineVersion: { type: 'string', minLength: 1 }
    }
};
const fileMetadataSchema = {
    type: 'object', additionalProperties: false,
    required: ['path', 'bytes', 'sha256', 'encoding'],
    properties: {
        path: { type: 'string', minLength: 1 },
        bytes: { type: 'integer', minimum: 0 },
        sha256: hashSchema,
        encoding: { enum: ['identity', 'gzip'] }
    }
};
const errorRecordSchema = {
    type: 'object', additionalProperties: false,
    required: ['name', 'code', 'message', 'stackHash'],
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        code: nullableTextSchema(160),
        message: { type: 'string', maxLength: 4000 },
        stackHash: { anyOf: [hashSchema, { type: 'null' }] }
    }
};

export const RUN_MANIFEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/run-manifest.schema.json',
    title: 'RIA Run Manifest',
    type: 'object', additionalProperties: false,
    required: [
        'schemaVersion', 'caseId', 'sessionId', 'runId', 'status', 'sealed',
        'startedAt', 'endedAt', 'fixtureHash', 'versions', 'environment',
        'config', 'seed', 'counts', 'files', 'contentHash', 'recording', 'error', 'recovery'
    ],
    properties: {
        schemaVersion: { const: RIA_SCHEMA_VERSION },
        caseId: idSchema,
        sessionId: idSchema,
        runId: idSchema,
        status: { enum: ['recording', 'completed', 'interrupted', 'partial', 'failed'] },
        sealed: { type: 'boolean' },
        startedAt: dateTimeSchema,
        endedAt: { anyOf: [dateTimeSchema, { type: 'null' }] },
        fixtureHash: hashSchema,
        versions: versionsSchema,
        environment: environmentSchema,
        config: jsonObjectSchema,
        seed: { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 512 }, { type: 'null' }] },
        counts: {
            type: 'object', additionalProperties: false,
            required: ['commands', 'events', 'snapshots', 'uiActions'],
            properties: {
                commands: { type: 'integer', minimum: 0 },
                events: { type: 'integer', minimum: 0 },
                snapshots: { type: 'integer', minimum: 0 },
                uiActions: { type: 'integer', minimum: 0 }
            }
        },
        files: { type: 'object', additionalProperties: fileMetadataSchema },
        recording: {
            type: 'object', additionalProperties: false,
            required: ['writerPid', 'bytesWritten', 'completedWrites', 'failures', 'droppedFacts'],
            properties: {
                writerPid: { type: 'integer', minimum: 1 },
                bytesWritten: { type: 'integer', minimum: 0 },
                completedWrites: { type: 'integer', minimum: 0 },
                failures: { type: 'array', items: errorRecordSchema },
                droppedFacts: { type: 'integer', minimum: 0 },
                capacityExceeded: { type: 'boolean' },
                streamBytes: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        commands: { type: 'integer', minimum: 0 },
                        events: { type: 'integer', minimum: 0 },
                        snapshots: { type: 'integer', minimum: 0 },
                        uiActions: { type: 'integer', minimum: 0 }
                    }
                }
            }
        },
        contentHash: { anyOf: [hashSchema, { type: 'null' }] },
        error: { anyOf: [errorRecordSchema, { type: 'null' }] },
        recovery: { anyOf: [jsonObjectSchema, { type: 'null' }] }
    }
};

const identityProperties = {
    actorId: nullableDomainIdSchema,
    ownerId: nullableDomainIdSchema,
    carrierId: nullableDomainIdSchema,
    targetId: nullableDomainIdSchema,
    damageSourceId: nullableDomainIdSchema,
    commandId: nullableDomainIdSchema,
    skillId: nullableDomainIdSchema,
    inputSkillId: nullableDomainIdSchema,
    executedSkillId: nullableDomainIdSchema,
    inputCommandType: nullableTextSchema(160),
    effectiveSkillType: nullableTextSchema(160),
    castId: nullableDomainIdSchema,
    rootCastId: nullableDomainIdSchema,
    parentCastId: nullableDomainIdSchema,
    childCastId: nullableDomainIdSchema,
    originActorId: nullableDomainIdSchema,
    originSkillId: nullableDomainIdSchema,
    originRootSkillId: nullableDomainIdSchema,
    originInputSkillId: nullableDomainIdSchema,
    originExecutedSkillId: nullableDomainIdSchema,
    originInputCommandType: nullableTextSchema(160),
    originEffectiveSkillType: nullableTextSchema(160),
    originCastId: nullableDomainIdSchema,
    originRootCastId: nullableDomainIdSchema,
    originParentCastId: nullableDomainIdSchema,
    triggerActorId: nullableDomainIdSchema,
    triggerSkillId: nullableDomainIdSchema,
    triggerRootSkillId: nullableDomainIdSchema,
    triggerInputSkillId: nullableDomainIdSchema,
    triggerExecutedSkillId: nullableDomainIdSchema,
    triggerInputCommandType: nullableTextSchema(160),
    triggerEffectiveSkillType: nullableTextSchema(160),
    triggerCastId: nullableDomainIdSchema,
    triggerRootCastId: nullableDomainIdSchema,
    triggerParentCastId: nullableDomainIdSchema,
    consumerActorId: nullableDomainIdSchema,
    consumerSkillId: nullableDomainIdSchema,
    consumerCastId: nullableDomainIdSchema,
    consumerRootCastId: nullableDomainIdSchema
};
const transitionSchema = {
    anyOf: [{
        type: 'object', additionalProperties: false,
        required: [
            'kind', 'resourceType', 'buffId', 'instanceId', 'before', 'requested',
            'delta', 'after', 'grantIds', 'reason'
        ],
        properties: {
            kind: { enum: ['grant', 'consume', 'refresh', 'expire', 'remove', 'change'] },
            resourceType: nullableTextSchema(512),
            buffId: nullableDomainIdSchema,
            instanceId: nullableDomainIdSchema,
            before: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            requested: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            delta: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            after: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            grantIds: { type: 'array', items: domainIdSchema },
            reason: nullableTextSchema(1000)
        }
    }, { type: 'null' }]
};

export const EVENT_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/event.schema.json',
    title: 'RIA Normalized Event',
    type: 'object', additionalProperties: false,
    required: [
        'schemaVersion', 'caseId', 'sessionId', 'runId', 'sequence', 'frame',
        'tick', 'eventType', 'actorId', 'targetId', 'castId', 'rootCastId',
        'parentCastId', 'childCastId', 'source', 'transition',
        'data', 'eventHash'
    ],
    properties: {
        schemaVersion: { const: RIA_SCHEMA_VERSION },
        caseId: idSchema,
        sessionId: idSchema,
        runId: idSchema,
        sequence: { type: 'integer', minimum: 1 },
        frame: { type: 'number', minimum: 0 },
        tick: { type: 'number', minimum: 0 },
        eventType: { type: 'string', minLength: 1, maxLength: 160 },
        ...identityProperties,
        primaryIdentityRole: { enum: ['action', 'trigger'] },
        source: {
            type: 'object', additionalProperties: false,
            required: ['authority', 'stream', 'nativeEventId', 'nativeSequence'],
            properties: {
                authority: { enum: ['runtime-fact', 'runtime-projection', 'ui-projection'] },
                stream: { type: 'string', minLength: 1, maxLength: 240 },
                nativeEventId: nullableDomainIdSchema,
                nativeSequence: { anyOf: [{ type: 'number' }, { type: 'null' }] }
            }
        },
        transition: transitionSchema,
        damage: jsonObjectSchema,
        data: jsonObjectSchema,
        eventHash: hashSchema
    }
};

export const SNAPSHOT_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/state-snapshot.schema.json',
    title: 'RIA Provable State Snapshot',
    type: 'object', additionalProperties: false,
    required: [
        'schemaVersion', 'caseId', 'sessionId', 'runId', 'sequence', 'frame',
        'state', 'evidence'
    ],
    properties: {
        schemaVersion: { const: RIA_SCHEMA_VERSION },
        caseId: idSchema,
        sessionId: idSchema,
        runId: idSchema,
        sequence: { type: 'integer', minimum: 1 },
        frame: { type: 'number', minimum: 0 },
        state: jsonObjectSchema,
        evidence: {
            type: 'object', additionalProperties: false,
            required: ['source', 'fromEventSequence', 'toEventSequence'],
            properties: {
                source: { const: 'normalized-fact-projection' },
                fromEventSequence: { type: 'integer', minimum: 1 },
                toEventSequence: { type: 'integer', minimum: 1 }
            }
        }
    }
};

export const UI_ACTION_APPEND_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/ui-action-append-request.schema.json',
    type: 'object', additionalProperties: false, required: ['actionType'],
    properties: {
        actionType: { type: 'string', minLength: 1, maxLength: 160 },
        occurredAt: dateTimeSchema,
        actor: { type: 'string', minLength: 1, maxLength: 160 },
        frame: { type: 'number', minimum: 0 },
        commandId: nullableDomainIdSchema,
        payload: jsonObjectSchema
    }
};

export const START_RUN_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/start-run-request.schema.json',
    type: 'object', additionalProperties: false,
    required: ['caseId', 'sessionId', 'fixture'],
    properties: {
        caseId: idSchema,
        sessionId: idSchema,
        runId: idSchema,
        fixture: { type: 'object', additionalProperties: true },
        config: jsonObjectSchema,
        seed: { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 512 }, { type: 'null' }] },
        uiActions: { type: 'array', maxItems: 100_000, items: UI_ACTION_APPEND_REQUEST_SCHEMA }
    }
};

export const REPLAY_REQUEST_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/replay-request.schema.json',
    type: 'object', additionalProperties: false,
    properties: { sessionId: idSchema, replayRunId: idSchema }
};

export const ERROR_RESPONSE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ake-cleanroom.local/ria/schemas/error-response.schema.json',
    type: 'object', additionalProperties: false, required: ['error'],
    properties: {
        error: {
            type: 'object', additionalProperties: false,
            required: ['code', 'message', 'details'],
            properties: {
                code: { type: 'string', minLength: 1, maxLength: 160 },
                message: { type: 'string', minLength: 1, maxLength: 4000 },
                details: {}
            }
        }
    }
};

export const RIA_SCHEMAS = Object.freeze({
    case: CASE_SCHEMA,
    caseCreateRequest: CASE_CREATE_REQUEST_SCHEMA,
    caseCloseRequest: CASE_CLOSE_REQUEST_SCHEMA,
    session: SESSION_SCHEMA,
    sessionCreateRequest: SESSION_CREATE_REQUEST_SCHEMA,
    sessionCreateBody: SESSION_CREATE_BODY_SCHEMA,
    sessionEntry: SESSION_ENTRY_SCHEMA,
    sessionEntryAppendRequest: SESSION_ENTRY_APPEND_REQUEST_SCHEMA,
    runManifest: RUN_MANIFEST_SCHEMA,
    event: EVENT_SCHEMA,
    snapshot: SNAPSHOT_SCHEMA,
    uiActionAppendRequest: UI_ACTION_APPEND_REQUEST_SCHEMA,
    startRunRequest: START_RUN_REQUEST_SCHEMA,
    replayRequest: REPLAY_REQUEST_SCHEMA,
    errorResponse: ERROR_RESPONSE_SCHEMA
});

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true, messages: true });
addFormats(ajv);
const validators = new Map(Object.entries(RIA_SCHEMAS).map(([name, schema]) => [
    name, ajv.compile(schema)
]));

function formatErrors(errors = []) {
    return errors.map(error => ({
        instancePath: error.instancePath || '/',
        schemaPath: error.schemaPath,
        keyword: error.keyword,
        message: error.message,
        params: error.params
    }));
}

export function validateSchema(name, value, label = name) {
    const validator = validators.get(name);
    if (!validator) throw new TypeError(`Unknown RIA schema: ${name}`);
    if (!validator(value)) {
        const errors = formatErrors(validator.errors);
        throw new RiaInputError(
            `${label} does not satisfy the RIA JSON Schema: ${errors
                .map(error => `${error.instancePath} ${error.message}`).join('; ')}`,
            'RIA_SCHEMA_INVALID',
            { schema: name, errors }
        );
    }
    return value;
}

export const validateCase = value => validateSchema('case', value, 'case');
export const validateCaseCreateRequest = value => validateSchema(
    'caseCreateRequest', value, 'case create request'
);
export const validateCaseCloseRequest = value => validateSchema(
    'caseCloseRequest', value, 'case close request'
);
export const validateSession = value => validateSchema('session', value, 'session');
export const validateSessionCreateRequest = value => validateSchema(
    'sessionCreateRequest', value, 'session create request'
);
export const validateSessionEntry = (value, previousSequence = 0) => {
    validateSchema('sessionEntry', value, 'session entry');
    const { contentHash, ...content } = value;
    if (contentHash !== hashJson(content)) {
        throw new RiaInputError(
            `session entry ${value.sequence} content hash does not match its content.`,
            'RIA_SESSION_ENTRY_HASH_MISMATCH'
        );
    }
    if (value.sequence <= previousSequence) {
        throw new RiaInputError(
            `session entry sequence ${value.sequence} must follow ${previousSequence}.`,
            'RIA_SEQUENCE_GAP'
        );
    }
    return value;
};
export const validateSessionEntryAppendRequest = value => validateSchema(
    'sessionEntryAppendRequest', value, 'session entry append request'
);
export const validateRunManifest = value => validateSchema('runManifest', value, 'run manifest');
export function validateEvent(value, previousSequence = 0) {
    validateSchema('event', value, 'event');
    if (value.primaryIdentityRole === 'trigger') {
        const pairs = [
            ['actorId', 'triggerActorId'],
            ['skillId', 'triggerSkillId'],
            ['inputSkillId', 'triggerInputSkillId'],
            ['executedSkillId', 'triggerExecutedSkillId'],
            ['inputCommandType', 'triggerInputCommandType'],
            ['effectiveSkillType', 'triggerEffectiveSkillType'],
            ['castId', 'triggerCastId'],
            ['rootCastId', 'triggerRootCastId'],
            ['parentCastId', 'triggerParentCastId']
        ];
        if (pairs.some(([primary, trigger]) => value[primary] !== value[trigger])) {
            throw new RiaInputError(
                `event ${value.sequence} mixes primary and trigger action identities.`,
                'RIA_EVENT_IDENTITY_MIXED'
            );
        }
    }
    if (value.sequence <= previousSequence) {
        throw new RiaInputError(
            `event sequence ${value.sequence} must follow ${previousSequence}.`,
            'RIA_SEQUENCE_GAP'
        );
    }
    return value;
}
export function validateSnapshot(value, previousSequence = 0) {
    validateSchema('snapshot', value, 'snapshot');
    if (value.sequence <= previousSequence) {
        throw new RiaInputError(
            `snapshot sequence ${value.sequence} must follow ${previousSequence}.`,
            'RIA_SEQUENCE_GAP'
        );
    }
    return value;
}

export function schemaDocument() {
    return {
        schemaVersion: RIA_SCHEMA_VERSION,
        validator: { engine: 'ajv', draft: '2020-12' },
        schemas: RIA_SCHEMAS,
        eventAuthority: {
            'runtime-fact': 'Directly observed at the existing runner/runtime/state-machine fact source.',
            'runtime-projection': 'Lossless causal projection of runtime facts, such as logical team-combo events.',
            'ui-projection': 'Display-oriented derivation; never authoritative for combat rules.'
        }
    };
}
