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
/**
 * Character ceiling for one unit — i.e. for one judgment request.
 *
 * Measured on this machine: the hosted model rejects an oversized state outright
 * (`Jev 400 {"error_type":"max_tokens_exceeded"}`), and nine such failures had
 * accumulated in the ledger, all of them on `private_scan`/`commit_message` — the two
 * channels a push gate depends on, failing on the *largest* diffs.
 *
 * The remedy is to **split**, not to truncate. Truncating would drop the tail of a long
 * minified line or a base64 blob, which is exactly where a leaked credential hides;
 * splitting costs one more request and keeps the coverage. 12000 characters sits well
 * under the smallest state known to succeed (59311 chars) and keeps a request cheap.
 */
export const MAX_UNIT_CHARS = 12000;
/**
 * Split units so that no single request can be rejected for size.
 *
 * A unit is split on line boundaries where possible. A *single* line can itself exceed
 * the ceiling (a minified bundle, a base64 payload), and that case is sliced — with the
 * part index kept in `where`, so a finding still points at something a reader can find.
 *
 * @param units - units from any splitter.
 * @param maxChars - the ceiling; defaults to {@link MAX_UNIT_CHARS}.
 * @returns the same units, with oversized ones replaced by consecutive parts.
 */
export function splitOversized(units, maxChars = MAX_UNIT_CHARS) {
    const out = [];
    for (const unit of units) {
        if (unit.text.length <= maxChars) {
            out.push(unit);
            continue;
        }
        const parts = [];
        let chunk = [];
        let size = 0;
        const flush = () => {
            if (!chunk.length)
                return;
            parts.push(chunk.join('\n'));
            chunk = [];
            size = 0;
        };
        for (const line of unit.text.split('\n')) {
            if (line.length > maxChars) {
                flush();
                for (let at = 0; at < line.length; at += maxChars)
                    parts.push(line.slice(at, at + maxChars));
                continue;
            }
            if (size + line.length + 1 > maxChars)
                flush();
            chunk.push(line);
            size += line.length + 1;
        }
        flush();
        parts.forEach((text, i) => out.push({ text, where: `${unit.where}（第 ${i + 1}/${parts.length} 段）` }));
    }
    return out;
}
/** Is this text a unified diff rather than prose? */
export function isDiff(text) {
    return /^diff --git /m.test(text) || /^@@ -\d+/m.test(text) || /^\+\+\+ b\//m.test(text);
}
/** The file a diff section belongs to, from its `+++ b/...` header. */
function fileOf(lines, from) {
    for (let i = from; i >= 0 && i > from - 200; i--) {
        const match = /^\+\+\+ b\/(.+)$/.exec(lines[i] ?? '');
        if (match)
            return match[1];
        const created = /^diff --git a\/(\S+) /.exec(lines[i] ?? '');
        if (created)
            return created[1];
    }
    return '(unknown file)';
}
/**
 * Split a diff into the *added* lines, grouped into runs.
 *
 * Only `+` lines: a privacy scan or a scope check is about what the commit
 * introduces, and context lines would both cost money and dilute the judgment.
 * A run of up to `runLines` consecutive additions becomes one unit, prefixed with
 * the file it belongs to — the model needs to know *where* the text lives, not
 * just what it says.
 */
export function diffUnits(diff, runLines = 12, max = 40) {
    const lines = diff.split('\n');
    const units = [];
    let run = [];
    let runStart = 0;
    const flush = () => {
        if (!run.length)
            return;
        const file = fileOf(lines, runStart);
        units.push({ text: `# ${file}\n${run.join('\n')}`, where: `${file}:${runStart + 1}` });
        run = [];
    };
    for (let i = 0; i < lines.length && units.length < max; i++) {
        const line = lines[i];
        if (line.startsWith('+') && !line.startsWith('+++')) {
            if (!run.length)
                runStart = i;
            run.push(line);
            if (run.length >= runLines)
                flush();
            continue;
        }
        flush();
    }
    flush();
    return units.slice(0, max);
}
/**
 * Split prose into paragraphs, dropping the ones too short to judge.
 *
 * A twelve-character line cannot carry a secret and cannot be out of scope;
 * sending it would spend a request to learn nothing (the same reasoning jev-tools
 * documented as its `minTaskChars` floor).
 */
export function textUnits(text, max = 40, minChars = 24) {
    const blocks = String(text).split(/\n\s*\n/);
    const units = [];
    let offset = 0;
    for (const block of blocks) {
        const trimmed = block.trim();
        const where = `offset ${offset}`;
        offset += block.length + 2;
        if (trimmed.length < minChars)
            continue;
        units.push({ text: trimmed.slice(0, 1500), where });
        if (units.length >= max)
            break;
    }
    return units;
}
/** The right splitter for the artifact at hand. */
export function unitsOf(text, max = 40) {
    /*
     * `max` bounds how many units the splitter *finds* (files, hunks, runs); the size
     * split runs after it, so a single oversized unit becomes several small ones instead
     * of one rejected request. The caller's own cap (`config.maxItems`) still applies to
     * the result, and anything it drops is reported as `skipped` rather than vanishing.
     */
    return splitOversized(isDiff(text) ? diffUnits(text, 12, max) : textUnits(text, max));
}
/**
 * Split a diff into hunks — one unit per `@@` block, with its header kept.
 *
 * The header is what makes the judgment possible at all: `@@ -12,7 +12,9 @@` plus
 * a few lines of context is how a reader decides whether a change belongs to the
 * task, and it is the same information the model gets.
 */
export function hunksOf(diff, max = 40, maxLines = 60) {
    const lines = diff.split('\n');
    const units = [];
    let header = '';
    let body = [];
    let at = 0;
    const flush = () => {
        if (!header)
            return;
        const file = fileOf(lines, at);
        units.push({ text: `# ${file}\n${header}\n${body.slice(0, maxLines).join('\n')}`, where: `${file} ${header.slice(0, 60)}` });
        header = '';
        body = [];
    };
    for (let i = 0; i < lines.length && units.length < max; i++) {
        const line = lines[i];
        if (line.startsWith('@@')) {
            flush();
            header = line;
            at = i;
            continue;
        }
        if (header)
            body.push(line);
    }
    flush();
    if (units.length)
        return splitOversized(units.slice(0, max));
    // Not a diff at all: fall back to added-line runs so the tool still says something.
    return splitOversized(diffUnits(diff, 20, max));
}
//# sourceMappingURL=segments.js.map