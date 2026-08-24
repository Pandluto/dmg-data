export function evaluateAttributeComponent(component) {
    if (!component || typeof component !== 'object') {
        throw new TypeError('Attribute component must be an object.');
    }

    const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const rawValue = number(component.rawValue, 0);
    const baseAddition = number(component.baseAddition, 0);
    const baseMultiplier = number(component.baseMultiplier, 1);
    const baseFinalAddition = number(component.baseFinalAddition, 0);
    const baseFinalMultiplier = number(component.baseFinalMultiplier, 1);
    const addition = number(component.addition, 0);
    const multiplier = number(component.multiplier, 1);
    const finalAddition = number(component.finalAddition, 0);
    const finalMultiplier = number(component.finalMultiplier, 1);

    const afterBase = (rawValue + baseAddition) * baseMultiplier;
    const afterBaseFinal = (afterBase + baseFinalAddition) * baseFinalMultiplier;
    const afterRuntime = (afterBaseFinal + addition) * multiplier;
    const value = (afterRuntime + finalAddition) * finalMultiplier;

    return {
        rawValue,
        baseAddition,
        baseMultiplier,
        baseFinalAddition,
        baseFinalMultiplier,
        addition,
        multiplier,
        finalAddition,
        finalMultiplier,
        afterBase,
        afterBaseFinal,
        afterRuntime,
        value
    };
}

