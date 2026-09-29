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
 * The third engine: AgentJev-0.6B, a local System One model with its **own** contract.
 *
 *   POST <endpoint>/api/evaluate
 *   { "state": {...}, "questions": [ { "id", "type": "boolean"|"choice"|"score", ... } ] }
 *   → { "results": [ { "answers": [ { "id", "type", "probability"|"value"|"score", … } ] } ],
 *       "usage": { "wall_ms": 462.2, "generated_tokens": 0 } }
 *
 * Laya spoke the kit's own shape because that shim was ours to write; AgentJev is a
 * published server (github.com/malevrigns/agent-jev) whose contract is a list of
 * typed questions, so the translation lives here and no external adapter is needed.
 * Measured on this machine (M2/16G, MPS, fp32, 317 fixtures): 122.5 s for the whole
 * suite at concurrency 4, p50 1015 ms per call, ~2.6 calls/s — slower per call than
 * the hosted engine (p50 ~320 ms) and behind it on quality, which is why it ships as
 * a **fallback**, not as the primary engine.
 */
export function toAgentJevQuestions(questions) {
    return Object.entries(questions).map(([id, question]) => {
        if (question.type === 'noul') {
            const item = { id, type: 'boolean', instructions: question.instructions };
            if (question.criteria)
                item.criteria = question.criteria;
            return item;
        }
        if (question.type === 'choice')
            return { id, type: 'choice', instructions: question.instructions, options: question.criteria };
        return { id, type: 'score', instructions: question.instructions, levels: question.criteria };
    });
}
/** Normalise one AgentJev response into the kit's answer shape. */
export function fromAgentJevAnswers(body) {
    const payload = body;
    const results = payload?.results;
    if (!Array.isArray(results) || !results.length || !Array.isArray(results[0]?.answers)) {
        throw new Error('agentjev: response has no `results[].answers` array');
    }
    const answers = {};
    for (const result of results) {
        for (const answer of result.answers ?? []) {
            const id = String(answer.id ?? '');
            const probabilities = (answer.distribution ?? undefined);
            if (!id)
                continue;
            if (answer.type === 'boolean')
                answers[id] = { type: 'noul', noul: Number(answer.probability ?? 0), probabilities };
            else if (answer.type === 'choice')
                answers[id] = { type: 'choice', choice: String(answer.value ?? ''), probabilities };
            else if (answer.type === 'score')
                answers[id] = { type: 'score', score: Number(answer.score ?? 0), probabilities };
        }
    }
    if (!Object.keys(answers).length)
        throw new Error('agentjev: response carried no usable answers');
    return { answers, ms: Number(payload?.usage?.wall_ms ?? 0) };
}
export function agentJevEngine(options) {
    const url = options.endpoint.trim().replace(/\/+$/, '');
    return {
        id: 'agentjev',
        label: `AgentJev-0.6B (local, ${url || 'unconfigured'})`,
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
                throw new Error('agentjev: no endpoint configured');
            const response = await fetch(`${url}/api/evaluate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ state, questions: toAgentJevQuestions(questions) }),
                signal: AbortSignal.timeout(opts.timeoutMs),
            });
            if (!response.ok) {
                /*
                 * The server refuses over-length input instead of truncating it, and says so
                 * with a 400 that names the token count. Carrying that text through matters:
                 * `max_tokens_exceeded` means "this unit was never judged", not "clean".
                 */
                const detail = await response.text().catch(() => '');
                throw new Error(`agentjev: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
            }
            return fromAgentJevAnswers(await response.json());
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