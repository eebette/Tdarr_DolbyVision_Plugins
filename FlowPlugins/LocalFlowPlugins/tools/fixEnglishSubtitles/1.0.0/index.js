"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    /**
     * Subtitle Cleanup Plugin (Conservative)
     *
     * - Works on .srt files listed in subtitles.exports
     * - Only touches English (eng/en) entries
     * - Fixes common OCR character confusions:
     *   - standalone or dialog-leading l/|/1 → I (including leading '|')
     *   - l/|/1 → I when preceded by space and/or followed by apostrophe
     *   - optional | → I in the middle of words (spl|ne → splIne)
     *   - 0 → o when between letters
     *   - trailing q → g at end of word (e.g. somethinq → something)
     *   - splits glued contractions (I'min → I'm in, you'reup → you're up)
     * - Applies a tiny curated list of word-level fixes (teh→the, etc.)
     * - Mild punctuation spacing normalization
     *
     * subtitles.exports format (one per line):
     *   filename.srt|index|lang|codec|forced|title
     *
     * Work dir:
     *   args.variables.workDir
     */

    const fs = require("fs");
    const path = require("path");

    // Log helper (mirrors console + job log)
    function log(jobLog, msg) {
        jobLog(msg);
        console.log(msg);
    }

    // Resolve inputs that may be wrapped in {{{ }}} to reference args.* values
    function resolveInput(value, args) {
        if (typeof value !== "string") return value;
        const match = value.match(/^\{\{\{(.+)\}\}\}$/);
        if (!match) return value;
        try {
            const expr = match[1];
            const fn = new Function("args", `return ${expr};`);
            const resolved = fn(args);
            return resolved ?? "";
        } catch (err) {
            console.warn(`Failed to resolve placeholder ${value}: ${err.message}`);
            return value;
        }
    }

    // --- Small word-level correction dictionary (very conservative) ---
    const WORD_CORRECTIONS = {
        "teh": "the",
        "adn": "and",
        "woud": "would",
        "coud": "could",
        "shoud": "should",
        "becuase": "because",
        "dont": "don't",
        "wont": "won't",
        "cant": "can't",
        "alot": "a lot"
    };

    // --- Global char replacements (safe normalizations) ---
    const GLOBAL_CHAR_FIXES = [
        // Fancy quotes → plain
        { pattern: /[“”„»«]/g, replacement: '"' },
        { pattern: /[‘’]/g, replacement: "'" },
        // Ellipsis
        { pattern: /…/g, replacement: "..." },
        // Long dashes → normal hyphen (helps some players)
        { pattern: /[—–]/g, replacement: "-" }
    ];

    /**
     * Apply character-level and contextual fixes to a single subtitle line.
     *
     * This function:
     *   - Keeps SRT structure intact (indexes & timestamps handled by caller)
     *   - Works line-by-line on text-only lines
     */
    function cleanLine(line, stats) {
        let t = line;

        // 0) Remove stray invisible chars and ligatures
        const beforeZeroWidth = t;
        t = t.replace(/[\u200b\ufeff]/g, "");
        if (t !== beforeZeroWidth) stats.zeroWidthStrip++;

        const beforeLigatures = t;
        t = t.replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl");
        if (t !== beforeLigatures) stats.ligatureFix++;

        // 1) Global character normalizations
        GLOBAL_CHAR_FIXES.forEach(({ pattern, replacement }) => {
            const before = t;
            t = t.replace(pattern, replacement);
            if (t !== before) stats.globalReplacements++;
        });

        // 2) Contextual I-fixes for l / | / 1

        // 2a) "- l " / "-| " / "-1 " at line start → "- I "
        //     handles "-l mean, I do" and "- l mean..." forms
        t = t.replace(/^(\s*-\s*)[l|1|](?=\s)/gm, (match, dashPart) => {
            stats.iFix++;
            return dashPart + "I";
        });

        // 2b) "- l'" / "-|" / "-1'" → "- I'"
        t = t.replace(/^(\s*-\s*)[l|1|](?=')/gm, (match, dashPart) => {
            stats.iFix++;
            return dashPart + "I";
        });

        // 2c) Standalone l/|/1 between spaces: " l " / " | " / " 1 " → " I "
        t = t.replace(/(\s)[l|1|](\s)/g, (match, pre, post) => {
            stats.iFix++;
            return pre + "I" + post;
        });

        // 2d) Space + l/|/1 + apostrophe: " l'm" / " |'m" / " 1'm" → " I'm"
        t = t.replace(/(\s)[l|1|](?=')/g, (match, pre) => {
            stats.iFix++;
            return pre + "I";
        });

        // 2e) Line-leading '|' that behaves like "I" (your "| understand" case):
        //     "^| " or "   | " → "I " / "   I "
        t = t.replace(/^(\s*)\|(?=\s)/gm, (match, pre) => {
            stats.iFix++;
            return pre + "I";
        });

        // 2f) Space + '|' + letter: " |know" → " Iknow"
        //     (we'll let later rules / word corrections deal with spacing if needed)
        t = t.replace(/(\s)\|(?=[A-Za-z])/g, (match, pre) => {
            stats.iFix++;
            return pre + "I";
        });

        // 2g) Optional mid-word '|' → 'I' when between letters: "spl|ne" → "splIne"
        // (this uses a lookbehind; if your Node is too old, we can rewrite it)
        t = t.replace(/(?<=[A-Za-z])\|(?=[A-Za-z])/g, () => {
            stats.iFix++;
            return "I";
        });

        // 3) 0 → o between letters (h0w → how, n0thing → nothing)
        //    Only when surrounded by letters, to avoid "1080p" etc.
        t = t.replace(/(?<=[A-Za-z])0(?=[A-Za-z])/g, () => {
            stats.zeroToO++;
            return "o";
        });

        // 3b) OCR digits that look like letters (between letters only)
        t = t.replace(/(?<=[A-Za-z])5(?=[A-Za-z])/g, () => {
            stats.digitToLetter++;
            return "s";
        });
        t = t.replace(/(?<=[A-Za-z])1(?=[A-Za-z])/g, () => {
            stats.digitToLetter++;
            return "l";
        });
        t = t.replace(/(?<=[A-Za-z])8(?=[A-Za-z])/g, () => {
            stats.digitToLetter++;
            return "B";
        });

        // 4) Trailing q → g at end of word or before punctuation
        //    This addresses things like "somethinq." → "something."
        t = t.replace(/q(?=[\s\.\,\!\?\;:'"\)\]]|$)/g, () => {
            stats.qToG++;
            return "g";
        });

        // 5) Tiny, conservative word-level corrections
        t = t.replace(/\b[\w']+\b/g, (word) => {
            const lower = word.toLowerCase();
            const replacement = WORD_CORRECTIONS[lower];
            if (!replacement) return word;

            stats.wordCorrections++;

            // Preserve capitalization of the original word's first letter
            if (/^[A-Z]/.test(word)) {
                if (replacement.length === 0) return replacement;
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });

        // 6) Mild punctuation spacing normalization

        // 6a) Remove extra spaces before punctuation: "hello !" → "hello!"
        t = t.replace(/\s+([\.\!\?,;:])/g, (match, punc) => {
            stats.punctSpacing++;
            return punc;
        });

        // 6b) Ensure a space after sentence punctuation if followed by a letter:
        //     "Hello.This" → "Hello. This"
        t = t.replace(/([\.\!\?])([A-Za-z])/g, (match, punc, letter) => {
            stats.punctSpacing++;
            return punc + " " + letter;
        });

        // 6c) Normalize ellipsis spacing and leading hyphens
        const beforeEllipsis = t;
        t = t.replace(/\s+\.\.\./g, "...");
        t = t.replace(/\.\.\.(?=[A-Za-z])/g, "... ");
        if (t !== beforeEllipsis) stats.ellipsisSpacing++;

        // Normalize dialogue-leading hyphens to "- " when followed by text
        const beforeHyphen = t;
        t = t.replace(/^\s*-\s*(?=\S)/, "- ");
        t = t.replace(/--+/g, "-");
        if (t !== beforeHyphen) stats.hyphenNormalize++;

        // 6c) Collapse multiple spaces to one (but not touching tabs)
        const beforeSpaces = t;
        t = t.replace(/ {2,}/g, " ");
        if (t !== beforeSpaces) stats.spaceCollapse++;

        // 7) Split glued contractions: "I'min" → "I'm in", "you'reup" → "you're up"
        t = t.replace(
            /\b(I'm|you're|we're|they're|it's|he's|she's|I'd|you'd|he'd|she'd|we'd|they'd|I'll|you'll|he'll|she'll|we'll|they'll)([a-z]{2,})\b/g,
            (match, pref, suf) => {
                stats.contractionSplit++;
                return `${pref} ${suf}`;
            }
        );

        return t;
    }

    // ===============================
    // PLUGIN DETAILS
    // ===============================
    const details = () => ({
        name: "Fix English Subtitles",
        description: "Cleans common OCR errors in English subtitles.",
        style: { borderColor: "purple" },
        tags: "subtitles",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 7,
        icon: "faClosedCaptioning",
        inputs: [
            {
                label: "Subtitles Directory",
                name: "subtitlesDirectory",
                tooltip: "Directory containing subtitles to fix. Leave empty to use the Tdarr cache directory (default output of Extract PGS Subtitles).",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            }
        ],
        outputs: [{ number: 1, tooltip: "Continue to next step" }],
    });
    exports.details = details;

    // ===============================
    // MAIN PLUGIN
    // ===============================
    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "=== Subtitle Cleanup Plugin (Conservative) Start ===");

        const configuredDir = (resolveInput(args.inputs.subtitlesDirectory, args) || "").toString().trim() || "";
        const workDir = configuredDir.length > 0 ? configuredDir : args.workDir;
        const baseName = path.basename(args.inputFileObj.file, path.extname(args.inputFileObj.file));
        const defaultExportsFile = path.join(workDir, `${baseName}_subtitles.exports`);
        const legacyExportsFile = path.join(workDir, "subtitles.exports");
        const exportsFile = fs.existsSync(defaultExportsFile)
            ? defaultExportsFile
            : legacyExportsFile;

        if (!fs.existsSync(exportsFile)) {
            log(jobLog, "⚠ subtitles.exports not found → skipping subtitle cleanup.");
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 1,
                variables: args.variables
            };
        }

        const raw = fs.readFileSync(exportsFile, "utf8").trim();
        if (!raw) {
            log(jobLog, "⚠ subtitles.exports is empty → nothing to clean.");
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 1,
                variables: args.variables
            };
        }

        const lines = raw.split("\n");

        let totalFiles = 0;
        let updatedFiles = 0;

        for (const entry of lines) {
            if (!entry.trim()) continue;

            const parts = entry.split("|");
            const filename = parts[0];
            const lang = (parts[2] || "").toLowerCase();

            // Only adjust English subtitles
            if (lang !== "eng" && lang !== "en") continue;

            const srtPath = path.join(workDir, filename);
            if (!fs.existsSync(srtPath)) {
                log(jobLog, `⚠ Subtitle file not found: ${srtPath}`);
                continue;
            }

            totalFiles++;

            log(jobLog, `📝 Cleaning English subtitle file: ${filename}`);

            const originalText = fs.readFileSync(srtPath, "utf8");
            const srtLines = originalText.split("\n");

            const stats = {
                iFix: 0,
                zeroToO: 0,
                digitToLetter: 0,
                qToG: 0,
                wordCorrections: 0,
                punctSpacing: 0,
                spaceCollapse: 0,
                globalReplacements: 0,
                contractionSplit: 0,
                zeroWidthStrip: 0,
                ligatureFix: 0,
                ellipsisSpacing: 0,
                hyphenNormalize: 0
            };
            const cleanedLines = srtLines.map((line) => {
                // Preserve SRT structure:
                // - Index lines (pure integers)
                // - Timestamp lines ("00:00:00,000 --> 00:00:00,000")
                if (/^\d+$/.test(line)) return line;
                if (/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(line)) {
                    return line;
                }

                return cleanLine(line, stats);
            });

            const cleanedText = cleanedLines.join("\n");

            if (cleanedText !== originalText) {
                fs.writeFileSync(srtPath, cleanedText);
                updatedFiles++;
                log(jobLog,
                    `✔ Updated ${filename} | I-fixes=${stats.iFix}, 0→o=${stats.zeroToO}, q→g=${stats.qToG}, ` +
                    `digit→letter=${stats.digitToLetter}, wordFix=${stats.wordCorrections}, punct=${stats.punctSpacing}, ` +
                    `spaces=${stats.spaceCollapse}, globalChars=${stats.globalReplacements}, contractions=${stats.contractionSplit}, ` +
                    `zeroWidth=${stats.zeroWidthStrip}, ligatures=${stats.ligatureFix}, ellipsis=${stats.ellipsisSpacing}, ` +
                    `hyphen=${stats.hyphenNormalize}`
                );
            } else {
                log(jobLog, `✓ No changes needed for ${filename}`);
            }
        }

        log(jobLog,
            `=== Subtitle Cleanup Plugin Done — Processed ${totalFiles} English file(s), updated ${updatedFiles} ===`
        );

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();
