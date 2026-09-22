/**
 * Turning a big artifact into the units a judgment can actually be made about.
 *
 * Both splitters are pure and deliberately dumb. The temptation is to be clever
 * about what to send — but "how relevant is this chunk?" is exactly the judgment
 * Jev measured poorly, so the splitting must not depend on the model. What goes
 * to the model is decided here, deterministically, and the cap is what keeps a
 * 5000-line diff from turning into a 5000-request bill.
 *
 * @module dsh-jev-kit/segments
 */
/** One unit handed to a channel. `where` is human-facing provenance (file:line). */
export interface Unit {
    text: string;
    where: string;
}
/** Is this text a unified diff rather than prose? */
export declare function isDiff(text: string): boolean;
/**
 * Split a diff into the *added* lines, grouped into runs.
 *
 * Only `+` lines: a privacy scan or a scope check is about what the commit
 * introduces, and context lines would both cost money and dilute the judgment.
 * A run of up to `runLines` consecutive additions becomes one unit, prefixed with
 * the file it belongs to — the model needs to know *where* the text lives, not
 * just what it says.
 */
export declare function diffUnits(diff: string, runLines?: number, max?: number): Unit[];
/**
 * Split prose into paragraphs, dropping the ones too short to judge.
 *
 * A twelve-character line cannot carry a secret and cannot be out of scope;
 * sending it would spend a request to learn nothing (the same reasoning jev-tools
 * documented as its `minTaskChars` floor).
 */
export declare function textUnits(text: string, max?: number, minChars?: number): Unit[];
/** The right splitter for the artifact at hand. */
export declare function unitsOf(text: string, max?: number): Unit[];
/**
 * Split a diff into hunks — one unit per `@@` block, with its header kept.
 *
 * The header is what makes the judgment possible at all: `@@ -12,7 +12,9 @@` plus
 * a few lines of context is how a reader decides whether a change belongs to the
 * task, and it is the same information the model gets.
 */
export declare function hunksOf(diff: string, max?: number, maxLines?: number): Unit[];
