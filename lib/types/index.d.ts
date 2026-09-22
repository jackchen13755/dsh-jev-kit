/// <reference types="node" resolution-mode="require"/>
import { type JevQuestion } from './jev.js';
import { type Logger, type WebServerLike } from './host.js';
import { type KitSettings } from './settings.js';
export declare const name = "@dsh-external/dsh-jev-kit";
export declare const inject: string[];
/** Structural view of the host context. Compiles against `dsh-tools` alone. */
export interface KitContext {
    tools: {
        register(definition: unknown): () => void;
    };
    effect(callback: () => unknown, label?: string): void;
    inject?(deps: string[], callback: (scope: KitContext) => void): void;
    commands?: {
        register(definition: unknown): () => void;
    };
    webServer?: WebServerLike;
    logger?: Logger;
}
export interface Config extends KitSettings {
    endpoint: string;
    model: string;
    /** Explicit key, for a profile that has no credentials seam. */
    apiKey: string;
    apiKeyFile: string;
    ledgerDir: string;
    redact: boolean;
}
/** Resolve the key from the credential store, then the environment, then a file. */
export declare function resolveKey(config: Config, env?: NodeJS.ProcessEnv): {
    key: string;
    source: string;
};
export declare function apply(ctx: KitContext, input?: Partial<Config>): void;
/** Exported for the offline tests: the pieces that must not need a host to check. */
export { CHANNEL_LIST, channelOf } from './channels.js';
export { unitsOf, hunksOf, diffUnits, textUnits, isDiff } from './segments.js';
export { summarize as summarizeLedger } from './ledger.js';
export type { JevQuestion };
