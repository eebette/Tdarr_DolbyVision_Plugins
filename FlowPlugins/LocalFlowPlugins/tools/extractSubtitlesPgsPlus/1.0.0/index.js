"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    /**
     * Extract Subtitles (PgsToSrtPlus)
     *
     * Per requested language:
     *   1. Extract all text-based subtitle streams via ffmpeg → SRT
     *   2. If no non-commentary text subtitles exist for that language AND
     *      PGS tracks are present, run PgsToSrtPlus to OCR them to SRT
     *
     * Supports "extract all PGS" (per track) or "extract first PGS" (auto-detect)
     * per language. Uses the same _subtitles.exports manifest format as the
     * other subtitle plugins in this pipeline.
     */

    const fs = require("fs");
    const path = require("path");
    const { spawn, execSync } = require("child_process");

    function log(jobLog, msg) {
        jobLog(msg);
        console.log(msg);
    }

    function resolveInput(value, args) {
        if (typeof value !== "string") return value;
        const match = value.match(/^\{\{\{\s*(.+?)\s*\}\}\}$/);
        if (!match) return value;

        const baseExpr = match[1].trim();
        const attempts = [baseExpr];

        const userPrefixes = ["args.variables.user.", "variables.user."];
        userPrefixes.forEach((prefix) => {
            if (baseExpr.startsWith(prefix)) {
                attempts.push(baseExpr.replace(prefix, prefix.replace(".user", "")));
            }
        });

        for (const expr of attempts) {
            try {
                const fn = new Function("args", `return ${expr};`);
                const resolved = fn(args);
                if (resolved !== undefined && resolved !== null) return resolved;
            } catch (err) {
                console.warn(`Failed to resolve placeholder ${value} with expr "${expr}": ${err.message}`);
            }
        }

        return "";
    }

    const TEXT_CODECS = ["subrip", "ass", "ssa", "srt", "text", "mov_text", "webvtt"];

    function isPgs(codec) {
        const c = (codec || "").toLowerCase();
        return c.includes("pgs") || c.includes("hdmv");
    }

    function runProcess(cmdParts, jobLog, timeoutMs) {
        return new Promise((resolve, reject) => {
            const [program, ...procArgs] = cmdParts;
            const cmdStr = cmdParts.map(a => a.includes(" ") ? `"${a}"` : a).join(" ");
            log(jobLog, `📋 Command: ${cmdStr}`);

            const child = spawn(program, procArgs, { stdio: "pipe" });

            let timer;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    child.kill("SIGTERM");
                    reject(new Error(`Process timed out after ${Math.round(timeoutMs / 1000)}s`));
                }, timeoutMs);
            }

            child.on("error", (err) => {
                if (timer) clearTimeout(timer);
                reject(new Error(`Failed to start ${program}: ${err.message}`));
            });

            child.stdout.on("data", (data) => {
                const output = data.toString().trim();
                if (output) console.log(`[PgsToSrtPlus] ${output}`);
            });

            child.stderr.on("data", (data) => {
                const output = data.toString().trim();
                if (output) console.log(`[PgsToSrtPlus] ${output}`);
            });

            child.on("close", (code) => {
                if (timer) clearTimeout(timer);
                if (code === 0) return resolve();
                reject(new Error(`${program} exited with code ${code}`));
            });
        });
    }

    function runFFmpeg(ffmpegArgs, jobLog) {
        return new Promise((resolve, reject) => {
            const cmdStr = `ffmpeg ${ffmpegArgs.join(" ")}`;
            log(jobLog, `📋 Command: ${cmdStr}`);

            const child = spawn("ffmpeg", ffmpegArgs, { stdio: "pipe" });

            child.on("error", (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
            child.stdout.on("data", (data) => console.log(`[ffmpeg] ${data.toString().trim()}`));
            child.stderr.on("data", (data) => {
                const output = data.toString().trim();
                if (output) console.log(`[ffmpeg] ${output}`);
            });
            child.on("close", (code) => {
                if (code === 0) return resolve();
                reject(new Error(`ffmpeg exited with code ${code}`));
            });
        });
    }

    const details = () => ({
        name: "Extract Subtitles (PgsToSrtPlus)",
        description:
            "Extracts subtitles for requested languages. Text subtitles are extracted via ffmpeg. " +
            "PGS (image-based) subtitles are OCR'd to SRT using PgsToSrtPlus only when no " +
            "non-commentary text subtitles exist for a given language.",
        style: { borderColor: "purple" },
        tags: "subtitles",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 7,
        icon: "faClosedCaptioning",

        inputs: [
            {
                label: "PgsToSrtPlus Run Command",
                name: "pgsToSrtPlusCommand",
                tooltip:
                    "Command to run PgsToSrtPlus. Can be a binary path, docker run command, etc. " +
                    "Example: docker run --rm -v /media:/media ebette1/pgs-to-srt-plus:latest " +
                    "— If using Docker, ensure volume mounts map paths so the plugin's file paths are valid inside the container.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "text" },
            },
            {
                label: "Languages",
                name: "languages",
                tooltip:
                    "Comma-separated list of ISO 639-2 language codes to extract subtitles for. " +
                    "Example: eng,jpn,fre",
                inputType: "string",
                defaultValue: "eng",
                inputUI: { type: "text" },
            },
            {
                label: "Ollama URL",
                name: "ollamaUrl",
                tooltip: "Ollama endpoint URL for VLM-based OCR fallback. Passed to PgsToSrtPlus via --ollama flag.",
                inputType: "string",
                defaultValue: "http://127.0.0.1:11434",
                inputUI: { type: "text" },
            },
            {
                label: "Ollama Model",
                name: "ollamaModel",
                tooltip: "Ollama model name for OCR. Passed to PgsToSrtPlus via --model flag.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "text" },
            },
            {
                label: "Skip PGS When Text Exists",
                name: "skipPgsWhenTextExists",
                tooltip:
                    "When enabled, PGS tracks for a given language are skipped if non-commentary " +
                    "text subtitles already exist for that language. Disable to always OCR PGS " +
                    "tracks regardless of existing text subtitles.",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
            {
                label: "Extract All PGS Per Language",
                name: "extractAllPgs",
                tooltip:
                    "When enabled, extract ALL PGS subtitle tracks for each language (runs PgsToSrtPlus " +
                    "separately per track with --track). When disabled, extract only the first PGS track " +
                    "per language (PgsToSrtPlus auto-selects via --language).",
                inputType: "boolean",
                defaultValue: "false",
                inputUI: { type: "switch" },
            },
            {
                label: "Prefer Text Subtitle as Default",
                name: "preferTextDefault",
                tooltip:
                    "When enabled, if the original default subtitle is image-based (PGS) and a same-language, " +
                    "non-forced, non-commentary text subtitle exists, the default flag is transferred to the " +
                    "text subtitle. When disabled, the default flag always stays on the original stream.",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory to place exported subtitles. Leave empty to use the Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Preserve Stream Metadata",
                name: "preserveMetadata",
                tooltip:
                    "If true, preserve stream metadata (title, SDH/hearing_impaired, default, forced, etc.) " +
                    "in the manifest for downstream remux plugins.",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
        ],

        outputs: [{ number: 1, tooltip: "Continue to next step" }],
    });
    exports.details = details;

    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "=== Extract Subtitles (PgsToSrtPlus) Start ===");

        const ffprobe = args.inputFileObj.ffProbeData;
        const inputPath = args.inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        // --- Resolve inputs ---
        const pgsToSrtPlusCommand = (resolveInput(args.inputs.pgsToSrtPlusCommand, args) || "").toString().trim();
        const languagesRaw = (resolveInput(args.inputs.languages, args) || "").toString().trim();
        const ollamaUrl = (resolveInput(args.inputs.ollamaUrl, args) || "").toString().trim();
        const ollamaModel = (resolveInput(args.inputs.ollamaModel, args) || "").toString().trim();
        const skipPgsWhenTextExists = String(resolveInput(args.inputs.skipPgsWhenTextExists, args)) !== "false";
        const extractAllPgs = String(resolveInput(args.inputs.extractAllPgs, args)) === "true";
        const preferTextDefault = String(resolveInput(args.inputs.preferTextDefault, args)) !== "false";
        const preserveMetadata = String(resolveInput(args.inputs.preserveMetadata, args)) !== "false";
        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim();
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.workDir;

        const requestedLangs = languagesRaw.split(",").map(l => l.trim().toLowerCase()).filter(Boolean);
        if (requestedLangs.length === 0) {
            log(jobLog, "⚠ No languages specified — skipping.");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
        }

        log(jobLog, `ℹ Languages: ${requestedLangs.join(", ")} | Extract all PGS: ${extractAllPgs}`);

        // Parse the run command into program + base args
        const runCmdParts = pgsToSrtPlusCommand.split(/\s+/).filter(Boolean);
        if (runCmdParts.length === 0 && !extractAllPgs) {
            // PgsToSrtPlus not configured — can still extract text subs
            log(jobLog, "⚠ PgsToSrtPlus run command not configured. PGS OCR will be skipped.");
        }

        // --- Ensure work directory exists ---
        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating directory: ${workDir}`);
                fs.mkdirSync(workDir, { recursive: true });
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${workDir}`);
            console.error(err);
        }

        // --- Categorize all subtitle streams ---
        const allSubStreams = (ffprobe.streams || []).filter(s => s.codec_type === "subtitle");
        if (allSubStreams.length === 0) {
            log(jobLog, "⚠ No subtitle streams found — skip");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
        }

        // Build PGS-relative index mapping (across all languages)
        // PgsToSrtPlus's --track flag uses 0-based index within all PGS tracks in the file
        const allPgsStreams = allSubStreams.filter(s => isPgs(s.codec_name));
        const pgsRelativeIndexMap = new Map();
        allPgsStreams.forEach((s, i) => {
            pgsRelativeIndexMap.set(s.index, i);
        });

        log(jobLog, `Total subtitle streams: ${allSubStreams.length} (${allPgsStreams.length} PGS, ${allSubStreams.length - allPgsStreams.length} text)`);

        // Debug: log disposition flags from ffprobe for all subtitle streams
        for (const s of allSubStreams) {
            const d = s.disposition || {};
            log(jobLog, `  [ffprobe] idx=${s.index} codec=${s.codec_name} lang=${(s.tags?.language || "und")} default=${d.default} forced=${d.forced} comment=${d.comment} hi=${d.hearing_impaired} title="${s.tags?.title || ""}"`);
        }

        const exportsFile = path.join(workDir, `${baseName}_subtitles.exports`);
        fs.writeFileSync(exportsFile, ""); // clear or create
        const manifestEntries = [];

        // --- Process each requested language ---
        for (const lang of requestedLangs) {
            log(jobLog, `\n--- Processing language: ${lang} ---`);

            // Find subtitle streams matching this language
            const langStreams = allSubStreams.filter(s => {
                const streamLang = (s.tags?.language || "und").toLowerCase();
                return streamLang === lang;
            });

            const textStreams = langStreams.filter(s =>
                TEXT_CODECS.includes((s.codec_name || "").toLowerCase())
            );
            const pgsStreams = langStreams.filter(s => isPgs(s.codec_name));

            log(jobLog, `  ${lang}: ${textStreams.length} text stream(s), ${pgsStreams.length} PGS stream(s)`);

            // --- Step 1: Extract all text subtitles via ffmpeg ---
            for (const s of textStreams) {
                const ffmpegIdx = s.index;
                const codec = (s.codec_name || "").toLowerCase();
                const title = s.tags?.title || "";
                const outFile = `${baseName}_s${ffmpegIdx}_${lang}.srt`;
                const outPath = path.join(workDir, outFile);

                log(jobLog, `  ✔ Extracting text subtitle: idx=${ffmpegIdx}, codec=${codec}`);

                try {
                    const ffmpegArgs = ["-y", "-i", inputPath, "-map", `0:${ffmpegIdx}`, "-c:s", "srt"];
                    if (preserveMetadata) {
                        if (title) ffmpegArgs.push("-metadata:s:0", `title=${title}`);
                        if (lang !== "und") ffmpegArgs.push("-metadata:s:0", `language=${lang}`);
                    }
                    ffmpegArgs.push(outPath);
                    await runFFmpeg(ffmpegArgs, jobLog);
                } catch (err) {
                    log(jobLog, `  🚨 Failed extracting text subtitle idx=${ffmpegIdx}: ${err.message}`);
                    log(jobLog, `  ⏭ Skipping to next subtitle...`);
                    continue;
                }

                if (!fs.existsSync(outPath)) {
                    log(jobLog, `  🚫 Expected output missing: ${outPath}`);
                    continue;
                }

                manifestEntries.push({
                    file: outFile,
                    index: ffmpegIdx,
                    lang,
                    codec,
                    delay: parseFloat(s.start_time || 0),
                    forced: s.disposition?.forced ? 1 : 0,
                    title: preserveMetadata ? (title || "") : "",
                    hearingImpaired: s.disposition?.hearing_impaired ? 1 : 0,
                    visualImpaired: s.disposition?.visual_impaired ? 1 : 0,
                    isDefault: s.disposition?.default ? 1 : 0,
                    isComment: s.disposition?.comment ? 1 : 0,
                    isImageBased: false,
                });
            }

            // --- Step 2: Optionally skip PGS if non-commentary text subs exist ---
            if (skipPgsWhenTextExists) {
                const extractedTextEntries = manifestEntries.filter(
                    e => e.lang === lang && !e.isImageBased && !e.isComment
                );

                if (extractedTextEntries.length > 0) {
                    log(jobLog, `  ℹ ${extractedTextEntries.length} non-commentary text subtitle(s) found for ${lang} — skipping PGS extraction`);
                    continue;
                }
            }

            if (pgsStreams.length === 0) {
                log(jobLog, `  ℹ No PGS tracks for ${lang}`);
                continue;
            }

            // --- Step 3: Run PgsToSrtPlus on PGS tracks ---
            if (runCmdParts.length === 0) {
                log(jobLog, `  ⚠ PgsToSrtPlus command not configured — cannot OCR ${pgsStreams.length} PGS track(s) for ${lang}`);
                continue;
            }

            let tracksToExtract;
            if (extractAllPgs) {
                tracksToExtract = pgsStreams;
            } else {
                // Select all forced tracks + first non-forced, non-commentary track
                const forced = pgsStreams.filter(s => s.disposition?.forced);
                const main = pgsStreams.find(s => !s.disposition?.forced && !s.disposition?.comment);
                tracksToExtract = [...forced];
                if (main) tracksToExtract.push(main);
                if (tracksToExtract.length === 0) tracksToExtract = [pgsStreams[0]];
            }
            log(jobLog, `  🖼 Running PgsToSrtPlus on ${tracksToExtract.length} PGS track(s) for ${lang}`);

            for (const s of tracksToExtract) {
                const ffmpegIdx = s.index;
                const pgsIdx = pgsRelativeIndexMap.get(ffmpegIdx);
                const title = s.tags?.title || "";
                const codec = (s.codec_name || "").toLowerCase();
                const outFile = `${baseName}_s${ffmpegIdx}_${lang}.srt`;
                const outPath = path.join(workDir, outFile);

                // Build PgsToSrtPlus command
                const cmdParts = [...runCmdParts, inputPath];

                cmdParts.push("--language", lang);

                // Always specify --track so we control exactly which PGS track
                // is processed (prevents PgsToSrtPlus from auto-selecting unexpectedly)
                if (pgsIdx !== undefined) {
                    cmdParts.push("--track", pgsIdx.toString());
                }

                if (ollamaUrl) {
                    cmdParts.push("--ollama", ollamaUrl);
                }
                if (ollamaModel) {
                    cmdParts.push("--model", ollamaModel);
                }

                // PgsToSrtPlus treats --output as a directory, not a file path
                cmdParts.push("--output", workDir);

                try {
                    await runProcess(cmdParts, jobLog, 0);
                } catch (err) {
                    log(jobLog, `  🚨 PgsToSrtPlus failed for track idx=${ffmpegIdx} (pgs#${pgsIdx}): ${err.message}`);
                    log(jobLog, `  ⏭ Skipping to next track...`);
                    continue;
                }

                // PgsToSrtPlus writes to auto-generated name: {inputBaseName}.{lang}.srt
                // Find it and rename to our expected output filename
                const autoName = `${path.basename(inputPath, path.extname(inputPath))}.${lang}.srt`;
                const candidates = [
                    path.join(workDir, autoName),
                    path.join(path.dirname(inputPath), autoName),
                ];

                let outputReady = fs.existsSync(outPath) && fs.statSync(outPath).isFile();

                if (!outputReady) {
                    for (const candidate of candidates) {
                        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                            log(jobLog, `  🔄 Found PgsToSrtPlus output at: ${candidate}`);
                            fs.renameSync(candidate, outPath);
                            outputReady = true;
                            break;
                        }
                    }
                }

                if (!outputReady) {
                    log(jobLog, `  🚫 PgsToSrtPlus produced no output for track idx=${ffmpegIdx}`);
                    continue;
                }

                log(jobLog, `  ✔ PgsToSrtPlus output: ${outFile}`);

                manifestEntries.push({
                    file: outFile,
                    index: ffmpegIdx,
                    lang,
                    codec,
                    delay: parseFloat(s.start_time || 0),
                    forced: s.disposition?.forced ? 1 : 0,
                    title: preserveMetadata ? (title || "") : "",
                    hearingImpaired: s.disposition?.hearing_impaired ? 1 : 0,
                    visualImpaired: s.disposition?.visual_impaired ? 1 : 0,
                    isDefault: s.disposition?.default ? 1 : 0,
                    isComment: s.disposition?.comment ? 1 : 0,
                    isImageBased: true,
                });
            }
        }

        // --- If the default subtitle is image-based and a same-language text alternative
        //     exists, transfer the default to the text subtitle. Otherwise keep as-is. ---
        if (!preferTextDefault) {
            log(jobLog, `ℹ Prefer Text Default is disabled — keeping default flags on original streams`);
        }
        const defaultImageEntries = preferTextDefault
            ? manifestEntries.filter(e => e.isDefault && e.isImageBased)
            : [];
        for (const defaultEntry of defaultImageEntries) {
            const textAlt = manifestEntries.find(e =>
                !e.isImageBased && !e.isComment && !e.forced && e.lang === defaultEntry.lang
            );
            if (textAlt) {
                log(jobLog, `🔄 Transferring default from OCR subtitle (${defaultEntry.file}) to text subtitle (${textAlt.file})`);
                defaultEntry.isDefault = 0;
                textAlt.isDefault = 1;
            }
        }

        // --- Reorder manifest: default subtitle first ---
        const defaultIdx = manifestEntries.findIndex(e => e.isDefault);
        if (defaultIdx > 0) {
            const [defaultEntry] = manifestEntries.splice(defaultIdx, 1);
            manifestEntries.unshift(defaultEntry);
            log(jobLog, `🔄 Reordered manifest: moved default subtitle to first position: ${defaultEntry.file}`);
        }

        // --- Write manifest ---
        // Format: file|index|lang|codec|delay|forced|title|hearing_impaired|visual_impaired|default|comment
        for (const entry of manifestEntries) {
            const line = [
                entry.file, entry.index, entry.lang, entry.codec, entry.delay,
                entry.forced, entry.title, entry.hearingImpaired, entry.visualImpaired,
                entry.isDefault, entry.isComment
            ].join("|") + "\n";
            fs.appendFileSync(exportsFile, line);
        }

        log(jobLog, `\nManifest written: ${exportsFile} (${manifestEntries.length} entries)`);
        log(jobLog, "=== Extract Subtitles (PgsToSrtPlus) End ===");

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    };

    exports.plugin = plugin;

})();
