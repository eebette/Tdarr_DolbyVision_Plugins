"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    /**
     * Subtitle Extractor + Exports metadata file
     * - Extract one subtitle per language
     * - Prefer text formats, otherwise OCR PGS → SRT
     * - Creates subtitles.exports for MP4 remux metadata
     */

    const fs = require("fs");
    const path = require("path");
    const { execSync, execFileSync } = require("child_process");

    // Log helper (mirrors console + job log)
    function log(jobLog, msg) {
        jobLog(msg);
        console.log(msg);
    }

    // Resolve inputs that may be wrapped in {{{ }}} to reference args.* values
    function resolveInput(value, args) {
        if (typeof value !== "string") return value;
        const match = value.match(/^\{\{\{\s*(.+?)\s*\}\}\}$/);
        if (!match) return value;

        const baseExpr = match[1].trim();
        const attempts = [baseExpr];

        // Support both args.variables.user.* (old) and args.variables.* (new)
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

        // Unresolved placeholders should not propagate as literal "{{{...}}}"
        return "";
    }

    // ===============================
    // MKVINFO PARSER (Option #3)
    // ===============================
    function getSubtitleTrackNumbers(inputPath) {
        const raw = execSync(`mkvinfo "${inputPath}"`, {
            maxBuffer: 1024 * 1024 * 200
        }).toString();

        const lines = raw.split(/\r?\n/);

        const tracks = [];
        let current = null;

        for (let lineRaw of lines) {
            const line = lineRaw.trim();

            // Start of a new track block
            if (line === "| + Track" || line === "+ Track") {
                if (current && current.track_type && current.track_number) {
                    tracks.push(current);
                }
                current = {};
                continue;
            }

            if (!current) continue;

            // Track number
            let m = line.match(/Track number:\s*([0-9]+)/);
            if (m) {
                current.track_number = parseInt(m[1], 10);
                continue;
            }

            // Track type
            m = line.match(/Track type:\s*(\w+)/);
            if (m) {
                current.track_type = m[1];
                continue;
            }
        }

        // Push last track if complete
        if (current && current.track_type && current.track_number) {
            tracks.push(current);
        }

        const subtitleTracks = tracks
            .filter((t) => t.track_type === "subtitles")
            .map((t) => t.track_number);

        console.log("getSubtitleTrackNumbers → subtitle MKV tracks:", subtitleTracks);
        return subtitleTracks; // e.g. [6,7,8,...]
    }

    // ===============================
    // PLUGIN DETAILS
    // ===============================
    const details = () => ({
        name: "Extract PGS Subtitles",
        description: "Extract subtitles (preferring text, OCR PGS when needed).",
        style: { borderColor: "purple" },
        tags: "subtitles",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 6,
        icon: "faClosedCaptioning",

        inputs: [
            {
                label: "Dotnet Path",
                name: "dotnetPath",
                tooltip: "Full path to dotnet binary used to run PgsToSrt.",
                inputType: "string",
                defaultValue: "{{{args.variables.dotnetBin}}}",
                inputUI: { type: "directory" },
            },
            {
                label: "PgsToSrt Path",
                name: "pgsToSrtPath",
                tooltip: "Full path to PgsToSrt DLL/binary.",
                inputType: "string",
                defaultValue: "{{{args.variables.pgsToSrtDll}}}",
                inputUI: { type: "directory" },
            },
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory to place exported subtitles. Leave empty to use the Tdarr cache directory.",
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
        log(jobLog, "=== Subtitle Extractor Plugin Start ===");

        const ffprobe = args.inputFileObj.ffProbeData;
        const inputPath = args.inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.librarySettings.cache;

        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating directory: ${workDir}`);
                fs.mkdirSync(workDir, { recursive: true });
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${workDir}`);
            console.error(err);
        }

        const dotnetPath = (resolveInput(args.inputs.dotnetPath, args) || "").toString().trim();
        if (!dotnetPath) {
            log(jobLog, "🚫 Missing dotnet binary path (input: Dotnet Path).");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables, error: "Missing dotnetPath" };
        }

        const pgsToSrtPath = (resolveInput(args.inputs.pgsToSrtPath, args) || "").toString().trim();
        if (!pgsToSrtPath) {
            log(jobLog, "🚫 Missing PgsToSrt path (input: PgsToSrt Path).");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables, error: "Missing pgsToSrtPath" };
        }

        if (!ffprobe?.streams) {
            log(jobLog, "⚠ No streams available");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
        }

        const subtitleStreams = ffprobe.streams.filter((s) => s.codec_type === "subtitle");
        if (subtitleStreams.length === 0) {
            log(jobLog, "⚠ No subtitle streams → skip");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
        }

        // === Extract subtitle MKV track numbers via mkvinfo ===
        const mkvTrackNumbers = getSubtitleTrackNumbers(inputPath); // [6,7,8,...]
        log(jobLog, `mkvinfo subtitle tracks (MKV track numbers): ${mkvTrackNumbers}`);

        if (mkvTrackNumbers.length !== subtitleStreams.length) {
            log(jobLog,
                `⚠ mkvinfo subtitle track count (${mkvTrackNumbers.length}) != ffprobe subtitle stream count (${subtitleStreams.length}). ` +
                `Mapping by order anyway.`
            );
        }

        // Attach mkvTrack to each ffprobe subtitle stream by order
        const orderedSubtitleStreams = subtitleStreams;
        for (let i = 0; i < orderedSubtitleStreams.length; i++) {
            orderedSubtitleStreams[i].mkvTrack = mkvTrackNumbers[i]; // may be undefined if mismatch
        }

        const exportsFile = path.join(workDir, `${baseName}_subtitles.exports`);
        fs.writeFileSync(exportsFile, ""); // clear or create

        const preferredCodecs = ["subrip", "ass", "ssa", "srt", "text", "mov_text", "webvtt"];
        const tessMap = {
            eng: "eng", en: "eng",
            jpn: "jpn", ja: "jpn",
            fre: "fra", fr: "fra",
            spa: "spa", es: "spa",
            ger: "deu", de: "deu",
            ita: "ita", it: "ita",
            por: "por", pt: "por",
            chi: "chi_sim", zho: "chi_sim",
            kor: "kor", ko: "kor",
            und: "eng"
        };

        const langAdded = new Set();

        for (let i = 0; i < orderedSubtitleStreams.length; i++) {
            const s = orderedSubtitleStreams[i];

            const lang = (s.tags?.language || "und").toLowerCase();
            if (langAdded.has(lang)) continue;

            const codec = (s.codec_name || "").toLowerCase();
            const forced = s.disposition?.forced ? 1 : 0;
            const title = s.tags?.title || "";

            // MKV "Track number" from mkvinfo (1–N)
            const mkvTrackNumber = s.mkvTrack;

            if (!mkvTrackNumber) {
                log(jobLog,
                    `⚠ No mkvTrackNumber for subtitle stream index=${s.index}, lang=${lang}. ` +
                    `Falling back to ffprobe index for PgsToSrt (may be wrong).`
                );
            }

            // ffmpeg index: use ffprobe's global stream index
            const ffmpegIdx = s.index;
            const tLang = tessMap[lang] || "eng";
            const outFile = path.join(workDir, `${baseName}_${lang}.srt`);

            if (preferredCodecs.includes(codec)) {
                log(jobLog, `✔ Copy text subtitle: lang=${lang}, codec=${codec}, ffmpegIdx=${ffmpegIdx}`);

                const cmd = [
                    `ffmpeg -y -i "${inputPath}"`,
                    `-map 0:${ffmpegIdx}`,
                    `-c:s srt`,
                    `"${outFile}"`
                ].join(" ");

                execSync(cmd, { stdio: "inherit" });

            } else {
                // PGS → SRT via PgsToSrt, using MKV track number if available
                const trackForPgsToSrt = mkvTrackNumber || (ffmpegIdx + 1); // best effort fallback
                log(jobLog,
                    `🔄 OCR PGS → SRT: lang=${lang}, codec=${codec}, mkvTrack=${trackForPgsToSrt}, ffmpegIdx=${ffmpegIdx}`
                );

                const argsList = [
                    pgsToSrtPath,
                    `--input=${inputPath}`,
                    `--output=${outFile}`,
                    `--track=${trackForPgsToSrt}`,
                    `--tesseractlanguage=${tLang}`,
                    "--tesseractversion=5"
                ];
                log(jobLog, `🔧 PgsToSrt args: ${argsList.join(" ")}`);
                execFileSync(dotnetPath, argsList, { stdio: "inherit" });
            }

            // Append metadata (use MKV track number as the index column, per "option 3")
            fs.appendFileSync(
                exportsFile,
                `${path.basename(outFile)}|${mkvTrackNumber || ffmpegIdx}|${lang}|${codec}|${forced}|${title}\n`
            );

            langAdded.add(lang);
        }

        log(jobLog, "=== Subtitle Extractor Plugin End ===");

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();
