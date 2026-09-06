/**
 * Browser transport v1 keeps each authoritative hit and resource pool once.
 * The full core projection remains available to engine/debug consumers.
 * Burst.hitIndices addresses the response's top-level hits array in order;
 * sharedAtb/uspPools retain every original resource point, event and window.
 */
export function projectAkeTimelineTransport(timeline, canonicalHits) {
    const hitIndexById = new Map(canonicalHits.map((hit, index) => [hit.hitId, index]));
    if (hitIndexById.size !== canonicalHits.length || hitIndexById.has(undefined)
        || hitIndexById.has(null)) {
        throw new TypeError('Timeline transport requires unique canonical hit IDs.');
    }
    const { lanes, resourcePools, hitBursts, ...retained } = timeline;
    const representedPoolIds = new Set([
        timeline.sharedAtb?.poolId, ...(timeline.uspPools ?? []).map(pool => pool.poolId)
    ]);
    const otherResourcePools = (resourcePools ?? []).filter(pool => !representedPoolIds.has(pool.poolId));
    return {
        ...retained,
        transportProjection: {
            schemaVersion: 1,
            canonicalHitPath: '/hits',
            burstHitReferences: 'hitIndices',
            omittedAliases: ['lanes', 'resourcePools']
        },
        hitBursts: hitBursts.map(({ hits, ...marker }) => ({
            ...marker,
            hitIndices: hits.map(hit => {
                const index = hitIndexById.get(hit.hitId);
                if (index === undefined) {
                    throw new RangeError(`Timeline burst references an unknown hit: ${String(hit.hitId)}.`);
                }
                return index;
            })
        })),
        ...(otherResourcePools.length > 0 ? { otherResourcePools } : {})
    };
}
