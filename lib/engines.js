/** The hosted engine. Thin on purpose: `createJev` already owns retries and auth. */
export function jevEngine(resolve) {
    return {
        id: 'jev',
        label: 'TypeSafe Jev (hosted)',
        async available() { return (await resolve()) !== null; },
        async ask(state, questions, options) {
            const transport = await resolve();
            if (!transport)
                throw new Error('jev: no key resolved');
            const answer = await transport.ask(state, questions, { timeoutMs: options.timeoutMs, maxRetries: 1 });
            return { answers: answer.answers, ms: answer.ms };
        },
    };
}
/**
 * The local engine.
 *
 * Laya ships as PyTorch weights plus ONNX and MLX ports, not as a service, so this
 * speaks a deliberately boring HTTP contract that any of those wrappers can
 * implement in a few lines:
 *
 *   POST <endpoint>
 *   { "state": {...}, "questions": {...} }
 *   → { "answers": { "<key>": { "noul": 0.93 } | { "choice": "billing" } | { "score": 1.8 } } }
 *
 * That is the same shape `createJev` normalises, which is the point: if swapping
 * engines required changing the channels, the comparison would be measuring the
 * adapter instead of the model.
 */
export function layaEngine(options) {
    const url = options.endpoint.trim().replace(/\/+$/, '');
    return {
        id: 'laya',
        label: `Laya (local, ${url || 'unconfigured'})`,
        async available() {
            if (!url)
                return false;
            try {
                const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
                return response.ok;
            }
            catch {
                return false;
            }
        },
        async ask(state, questions, opts) {
            if (!url)
                throw new Error('laya: no endpoint configured');
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ state, questions }),
                signal: AbortSignal.timeout(opts.timeoutMs),
            });
            if (!response.ok)
                throw new Error(`laya: HTTP ${response.status}`);
            const body = (await response.json());
            if (!body || typeof body !== 'object' || typeof body.answers !== 'object' || body.answers === null) {
                throw new Error('laya: response has no `answers` object');
            }
            return { answers: body.answers, ms: Number(body.ms ?? 0) };
        },
    };
}
/**
 * Shrink a state to what a local engine can afford to read.
 *
 * Measured on an M2 with the ONNX English checkpoint: a 22-character state costs
 * ~100 ms while a 743-character one costs ~1.6 s, because a bidirectional encoder
 * re-reads the whole sequence on every call — there is no KV cache to warm, and
 * the vendor's 33 ms figure is a T4 GPU. Token count is therefore the first-order
 * cost of a local engine, and this is where a deployment controls it.
 *
 * Truncation is marked, never silent: the model is told the text was cut, so a
 * "no" on a truncated state is distinguishable from a "no" on the whole of it.
 *
 * @param state - the payload as the channel built it.
 * @param limits - `maxChars` per string (0 disables), `maxItems` per array.
 * @returns a trimmed copy plus how many fields were cut.
 */
export function trimState(state, limits) {
    if (limits.maxChars <= 0 && limits.maxItems <= 0)
        return { state, trimmed: 0 };
    let trimmed = 0;
    const cut = (value) => {
        if (limits.maxChars <= 0 || value.length <= limits.maxChars)
            return value;
        trimmed++;
        return `${value.slice(0, limits.maxChars)}…[truncated ${value.length - limits.maxChars} chars]`;
    };
    const out = {};
    for (const [field, value] of Object.entries(state)) {
        if (typeof value === 'string')
            out[field] = cut(value);
        else if (Array.isArray(value)) {
            const kept = limits.maxItems > 0 ? value.slice(0, limits.maxItems) : value;
            if (kept.length !== value.length)
                trimmed++;
            out[field] = kept.map(item => (typeof item === 'string' ? cut(item) : item));
        }
        else
            out[field] = value;
    }
    return { state: out, trimmed };
}
/**
 * Look up the engines named in settings, preserving the requested order.
 *
 * Returns unknown ids alongside the known ones so a typo in settings surfaces as
 * a named error instead of an engine that silently never ran.
 */
export function selectEngines(wanted, known) {
    const byId = new Map(known.map(engine => [engine.id, engine]));
    const engines = [];
    const unknown = [];
    for (const id of wanted) {
        const found = byId.get(id.trim().toLowerCase());
        if (found) {
            if (!engines.includes(found))
                engines.push(found);
        }
        else if (id.trim())
            unknown.push(id.trim());
    }
    return { engines, unknown };
}
//# sourceMappingURL=engines.js.map