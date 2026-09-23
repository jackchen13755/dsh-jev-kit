/**
 * Pluggable decision engines, so "which model should make this judgment" becomes
 * a measurement instead of an argument.
 *
 * One contract, three implementations: Jev (hosted), Laya (local, open weights),
 * and whatever comes next. An engine takes a state and typed questions and
 * returns typed answers — nothing else is assumed, because everything else
 * (calibration, latency, cost, privacy) is exactly what the benchmark exists to
 * compare rather than to presuppose.
 *
 * Two rules that keep the comparison honest:
 *
 *   · **Unavailable is a result, not a skip.** An engine that cannot be reached
 *     reports `unavailable` with a reason. It never returns an empty answer set
 *     that a caller might read as "nothing to flag".
 *   · **The engine never sees the expectation.** Fixtures carry their ground truth
 *     to the scorer, not to the model.
 *
 * @module dsh-jev-kit/engines
 */
import { type Jev, type JevQuestion, type JevAnswer } from './jev.js';
export interface AskResult {
    answers: Record<string, JevAnswer>;
    ms: number;
}
export interface Engine {
    id: string;
    label: string;
    /** True when the engine is reachable right now (probed lazily). */
    available(): Promise<boolean>;
    ask(state: Record<string, unknown>, questions: Record<string, JevQuestion>, options: {
        timeoutMs: number;
    }): Promise<AskResult>;
}
export interface EngineOptions {
    endpoint: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    /** Local engine endpoint, e.g. a Laya server speaking the same contract. */
    layaEndpoint: string;
}
/** The hosted engine. Thin on purpose: `createJev` already owns retries and auth. */
export declare function jevEngine(resolve: () => Promise<Jev | null>): Engine;
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
export declare function layaEngine(options: {
    endpoint: string;
}): Engine;
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
export declare function trimState(state: Record<string, unknown>, limits: {
    maxChars: number;
    maxItems: number;
}): {
    state: Record<string, unknown>;
    trimmed: number;
};
/**
 * Look up the engines named in settings, preserving the requested order.
 *
 * Returns unknown ids alongside the known ones so a typo in settings surfaces as
 * a named error instead of an engine that silently never ran.
 */
export declare function selectEngines(wanted: string[], known: Engine[]): {
    engines: Engine[];
    unknown: string[];
};
