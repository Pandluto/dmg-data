// Versioned input order is independent of time, event priority and geometry.
export function parseAkeOperationOrder(input) {
    const version = input.operationOrderVersion;
    if (version !== undefined && version !== 1) {
        throw new TypeError(`Unsupported operationOrderVersion: ${String(version)}.`);
    }
    const commands = input.commands ?? [];
    const switches = input.operatorSwitches ?? [];
    if (!Array.isArray(commands) || !Array.isArray(switches)) {
        throw new TypeError('commands and operatorSwitches must be arrays.');
    }
    const ids = new Set();
    const orders = new Set();
    for (const [kind, entries, idKey] of [
        ['commands', commands, 'commandId'], ['operatorSwitches', switches, 'switchId'],
    ]) {
        entries.forEach((entry, index) => {
            const label = `${kind}[${index}]`;
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new TypeError(`${label} must be an object.`);
            }
            if (version === undefined) {
                if (Object.hasOwn(entry, 'operationOrder')) {
                    throw new TypeError(`${label}.operationOrder requires operationOrderVersion: 1.`);
                }
                return;
            }
            if (Object.hasOwn(entry, 'timelineOrder')) {
                throw new TypeError(`${label}.timelineOrder is not allowed in v1.`);
            }
            const id = entry[idKey];
            if (typeof id !== 'string' || !id.trim()) {
                throw new TypeError(`${label}.${idKey} must be a non-empty stable identity in v1.`);
            }
            if (ids.has(id)) throw new TypeError(`Duplicate operation identity: ${id}.`);
            ids.add(id);
            const order = entry.operationOrder;
            if (!Number.isSafeInteger(order) || order < 0) {
                throw new TypeError(`${label}.operationOrder must be a non-negative safe integer.`);
            }
            if (orders.has(order)) throw new TypeError(`Duplicate operationOrder: ${order}.`);
            orders.add(order);
        });
    }
    return {
        version,
        isV1: version === 1,
        compare: (left, right) => left.operationOrder - right.operationOrder,
    };
}
