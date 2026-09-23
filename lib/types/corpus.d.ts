/**
 * The fixture corpus: dozens of labelled cases per channel.
 *
 * Two properties make this corpus worth more than a hand-written handful:
 *
 *   · **Truth by construction.** Where a case is composed (a privacy snippet made
 *     of elements I chose, a log line generated from a template), the label follows
 *     from what was injected rather than from a judgement call afterwards. Nobody
 *     can quietly relabel a case that a model got wrong.
 *   · **Both sides, in balance.** A separation number needs cases that should score
 *     high and cases that should score low, in comparable numbers. Every table here
 *     is built with that symmetry, and a test asserts it.
 *
 * The channel wording is never invented here: composed cases reuse the kit's own
 * channels, and the command cases carry `dsh-jev-lens`'s published questions
 * verbatim (see `bench.ts`).
 *
 * @module dsh-jev-kit/corpus
 */
import type { JevQuestion } from './jev.js';
import type { Fixture } from './bench.js';
export declare const LENS_DESTRUCTIVE: JevQuestion;
export declare const LENS_RESTORABLE: JevQuestion;
export declare const CORPUS: Fixture[];
/** How many fixtures each channel contributes — printed by the report. */
export declare function corpusByChannel(fixtures?: Fixture[]): Record<string, number>;
