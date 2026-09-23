/**
 * The channel catalogue: every judgment this toolkit can make.
 *
 * A channel is a *named decision* with four parts: the state it needs, the typed
 * questions it asks about that state, how the answers fold into a verdict, and
 * the advice that verdict produces. Keeping all four in one table is what makes
 * the toolkit auditable — the wording is the calibration, so it lives next to the
 * threshold that consumes it instead of scattered through call sites.
 *
 * Two rules shaped every entry:
 *
 *   · **Presence, not relevance.** Jev separates cleanly on "is X in this text?"
 *     and poorly on "how relevant is this?" (measured locally: 36 real code
 *     segments scored 0.02–0.66, so a 0.5 cut would have dropped 75% of them).
 *     Every question below is therefore phrased as a presence or category test.
 *   · **Advice, never enforcement.** Nothing here blocks, rewrites, or asks a
 *     human. A toolkit that could gate would inherit every failure mode of a
 *     gate — including the `approval: never` trap where an ask silently becomes
 *     a refusal with a false reason. This one only ever returns text.
 *
 * @module dsh-jev-kit/channels
 */
import type { JevAnswer, JevQuestion } from '@dsh-external/dsh-jev-core';
/** Apply fitted cuts to the readers (called with the same table as the benchmark). */
export declare function setReaderThresholds(map: Record<string, number> | undefined): void;
/** The effective cut for a channel inside a reader: override, else the literal default. */
export declare function readerThreshold(channel: string, fallback: number): number;
/** Which part of the catalogue a channel belongs to. `P` is the priority set. */
export type ChannelGroup = 'P' | 'A' | 'B' | 'C' | 'D';
/** How one judgment is read. */
export type VerdictLevel = 'ok' | 'info' | 'warn' | 'flag';
export interface Verdict {
    level: VerdictLevel;
    /** One line, safe to show the model or a human. */
    headline: string;
    /** Supporting numbers, never prose. */
    details?: string[];
    /** Raw answers, for the ledger and for callers that want their own policy. */
    values: Record<string, number | string | undefined>;
}
/** What a channel needs from its caller. Fields are referenced by name in the questions. */
export interface ChannelState {
    /** The thing under judgment: a segment, a hunk, a tool result, a diff. */
    text?: string;
    /**
     * A shell command, for the fixtures that measure another plugin's wording
     * verbatim (`dsh-jev-lens` names this field `command`, not `text`).
     */
    command?: string;
    /** The user's request or task, when the judgment is relative to one. */
    task?: string;
    /** A shortlist to choose from (components, tests, skills, memories). */
    candidates?: string[];
    /** The candidate list's meaning, for the question wording. */
    candidateNoun?: string;
    /** A requirement list to check an artifact against. */
    requirements?: string[];
    /** A second text, for pair judgments (dedup, contradiction). */
    other?: string;
    /** Extra scalar context the questions may name (e.g. a file path, a command). */
    extra?: Record<string, string>;
}
export interface ChannelSpec {
    id: string;
    group: ChannelGroup;
    /** Human title (zh-CN; the card and the report are read on this machine). */
    title: string;
    /** What it replaces, in one line — the reason it exists at all. */
    intent: string;
    /** One call per item, or one call for the whole input. */
    per: 'item' | 'input';
    /** The questions, as a function of the state so field names stay honest. */
    questions: (state: ChannelState) => Record<string, JevQuestion>;
    /** Fold the typed answers into a verdict. */
    read: (answers: Record<string, JevAnswer>, state: ChannelState) => Verdict;
    /** Probability above which a binary channel is called positive. */
    at?: number;
}
export declare const CHANNELS: Record<string, ChannelSpec>;
/** The catalogue as data, for the listing tool and the tests. */
export declare const CHANNEL_LIST: ChannelSpec[];
/** Suggested default thresholds, keyed by channel (overridable per call). */
export declare const DEFAULT_THRESHOLDS: Record<string, number>;
/** Resolve one channel by id, tolerating `-`/`_` spelling drift. */
export declare function channelOf(id: string): ChannelSpec | undefined;
