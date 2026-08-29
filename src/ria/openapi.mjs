import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { RiaError } from './common.mjs';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);

function resolvePointer(document, pointer) {
    if (!pointer.startsWith('#/')) return null;
    let current = document;
    for (const token of pointer.slice(2).split('/')) {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!current || typeof current !== 'object'
            || !Object.prototype.hasOwnProperty.call(current, key)) return null;
        current = current[key];
    }
    return current;
}

function walk(value, visit) {
    if (Array.isArray(value)) {
        value.forEach(entry => walk(entry, visit));
        return;
    }
    if (!value || typeof value !== 'object') return;
    visit(value);
    Object.values(value).forEach(entry => walk(entry, visit));
}

export function createOpenApiSchemaValidator(document) {
    const schemaAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(schemaAjv);
    schemaAjv.addSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'https://ake-cleanroom.local/ria/openapi-components.json',
        components: document.components
    });
    return (schemaName, value) => {
        const validator = schemaAjv.compile({
            $ref: `https://ake-cleanroom.local/ria/openapi-components.json#/components/schemas/${schemaName}`
        });
        return {
            valid: Boolean(validator(value)),
            errors: validator.errors ?? []
        };
    };
}

export async function validateOpenApiDocument(document) {
    const errors = [];
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new RiaError('OpenAPI document must be an object.', 'RIA_OPENAPI_INVALID');
    }
    if (!/^3\.(?:0|1)\./.test(String(document.openapi ?? ''))) {
        errors.push('openapi must declare a supported 3.0.x or 3.1.x version.');
    }
    if (!document.info?.title || !document.info?.version) {
        errors.push('info.title and info.version are required.');
    }
    if (!document.paths || typeof document.paths !== 'object') {
        errors.push('paths must be an object.');
    }
    const operationIds = new Set();
    for (const [route, item] of Object.entries(document.paths ?? {})) {
        const placeholders = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
        for (const [method, operation] of Object.entries(item ?? {})) {
            if (!HTTP_METHODS.has(method)) continue;
            if (!operation || typeof operation !== 'object') {
                errors.push(`${method.toUpperCase()} ${route} is not an operation object.`);
                continue;
            }
            if (!operation.operationId) errors.push(`${method.toUpperCase()} ${route} lacks operationId.`);
            else if (operationIds.has(operation.operationId)) {
                errors.push(`Duplicate operationId: ${operation.operationId}`);
            } else operationIds.add(operation.operationId);
            if (!operation.responses || Object.keys(operation.responses).length === 0) {
                errors.push(`${method.toUpperCase()} ${route} lacks responses.`);
            }
            const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
                .map(parameter => parameter.$ref
                    ? resolvePointer(document, parameter.$ref)
                    : parameter)
                .filter(Boolean);
            for (const placeholder of placeholders) {
                if (!parameters.some(parameter => (
                    parameter.in === 'path'
                    && parameter.name === placeholder
                    && parameter.required === true
                ))) errors.push(`${method.toUpperCase()} ${route} lacks required path parameter ${placeholder}.`);
            }
        }
    }
    walk(document, value => {
        if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')
            && resolvePointer(document, value.$ref) === null) {
            errors.push(`Unresolved local $ref: ${value.$ref}`);
        }
    });
    if (errors.length > 0) {
        throw new RiaError(
            `OpenAPI contract is invalid: ${errors.join(' ')}`,
            'RIA_OPENAPI_INVALID',
            500,
            { errors }
        );
    }
    try {
        await SwaggerParser.validate(structuredClone(document));
        const validateComponent = createOpenApiSchemaValidator(document);
        for (const name of Object.keys(document.components?.schemas ?? {})) {
            // Compilation is the validation here; an arbitrary null instance may
            // be invalid and is therefore not used as a schema probe.
            validateComponent(name, null);
        }
    } catch (error) {
        throw new RiaError(
            `OpenAPI parser rejected the contract: ${error.message}`,
            'RIA_OPENAPI_INVALID',
            500,
            { parser: '@apidevtools/swagger-parser' }
        );
    }
    return {
        ok: true,
        version: document.openapi,
        pathCount: Object.keys(document.paths).length,
        operationCount: operationIds.size
    };
}

export default validateOpenApiDocument;
