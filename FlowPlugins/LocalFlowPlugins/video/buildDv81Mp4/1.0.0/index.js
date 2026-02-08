"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    /**
     * Final MP4Box DV8.1 Remux Plugin (Async Spawn)
     * - Reads audio.exports + subtitles.exports metadata
     * - Uses metadata to assign clean names + conversion indicators
     */

    const fs = require("fs");
    const path = require("path");
    const {spawn} = require("child_process");

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

    // Safely format MP4Box name flag (pass raw spaces; spawn bypasses shell)
    function formatNameFlag(title, suffix = "") {
        if (!title) return "";
        const raw = `${title}${suffix}`.replace(/"/g, "");
        return `:name=${raw}`;
    }

    // Build a sensible audio title when none was supplied in the manifest
    function buildAudioTitle(title, lang, codec) {
        const cleaned = (title || "").trim();
        if (cleaned) return cleaned;

        const langPart = (lang || "").trim();
        const prettyLang = langPart ? langPart.toUpperCase() : "Audio";
        const labelMap = {
            eac3: "Dolby Digital Plus",
            ac3: "Dolby Digital",
            truehd: "TrueHD",
            dts: "DTS"
        };
        const codecLabel = labelMap[(codec || "").toLowerCase()] || (codec ? codec.toUpperCase() : "");
        return codecLabel ? `${prettyLang} - ${codecLabel}` : prettyLang;
    }

    function runMP4Box(mp4boxPath, args) {
        const libPathPrefix = "/home/Tdarr/opt/gpac/usr/lib";
        const env = {
            ...process.env,
            LD_LIBRARY_PATH: `${libPathPrefix}:${process.env.LD_LIBRARY_PATH || ""}`
        };
        return new Promise((resolve, reject) => {
            const child = spawn(mp4boxPath, args, {stdio: "pipe", env});

            child.on("error", (err) => {
                reject(new Error(`Failed to start MP4Box (${mp4boxPath}): ${err.message}`));
            });

            child.stdout.on("data", (data) => {
                console.log(`[MP4Box] ${data.toString().trim()}`);
            });

            child.stderr.on("data", (data) => {
                console.log(`[MP4Box] ${data.toString().trim()}`);
            });

            child.on("close", (code) => {
                if (code === 0) return resolve();
                reject(new Error(`MP4Box exited with code ${code}`));
            });
        });
    }

    const details = () => ({
        name: "Build DV8.1 MP4",
        description: "Remux DV8.1 BL, audio, and subtitles into MP4 via MP4Box.",
        style: {borderColor: "purple"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 8,
        icon: "faFilm",
        inputs: [
            {
                label: "BL DV8.1 HEVC Path",
                name: "blDv81HevcPath",
                tooltip: "Path to BL DV8.1 HEVC file (e.g., from Convert HEVC). Leave empty to use Tdarr cache directory + <basename>.hevc.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Audio Exports Path",
                name: "audioExportsPath",
                tooltip: "Path to audio exports manifest (from Extract Audio Tracks). Leave empty to use Tdarr cache directory + <basename>_audio.exports.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Subtitle Exports Path",
                name: "subtitleExportsPath",
                tooltip: "Path to subtitle exports manifest (optional). Leave empty to use Tdarr cache directory + <basename>_subtitles.exports.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "RPU Path",
                name: "rpuPath",
                tooltip: "Path to RPU file (from Extract RPU). Leave empty to use Tdarr cache directory + <basename>_RPU.bin.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "MP4Box Path",
                name: "mp4boxPath",
                tooltip: "Full path to MP4Box executable (Install DV Tools sets this).",
                inputType: "string",
                defaultValue: "{{{args.variables.mp4boxBin}}}",
                inputUI: { type: "directory" },
            },
            {
                label: "Delete Sources After Remux",
                name: "deleteSourcesAfterRemux",
                tooltip: "Delete the source files used to build the MP4 after remux completes (BL HEVC, audio/subtitle exports and tracks, RPU).",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
        ],
        outputs: [{number: 1, tooltip: "Continue to next step"}],
    });
    exports.details = details;

    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "=== Final DV8.1 MP4Box Remux Start (Async) ===");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));
        const workDir = args.workDir;

        const blHevc = (resolveInput(args.inputs.blDv81HevcPath, args)?.toString().trim()) || path.join(args.workDir, `${baseName}.hevc`);
        const audioExportsFile = (resolveInput(args.inputs.audioExportsPath, args)?.toString().trim()) || path.join(args.workDir, `${baseName}_audio.exports`);

        const userSubtitleExportsInput = (resolveInput(args.inputs.subtitleExportsPath, args) || "").toString().trim() || "";
        const subtitleExportsFile = userSubtitleExportsInput.length > 0
            ? userSubtitleExportsInput
            : path.join(args.workDir, `${baseName}_subtitles.exports`);

        const userRpuInput = (resolveInput(args.inputs.rpuPath, args) || "").toString().trim() || "";
        const defaultRpuPath = path.join(args.workDir, `${baseName}_RPU.bin`);
        let rpuFilePath = userRpuInput.length > 0 ? userRpuInput : defaultRpuPath;
        const mp4boxPath = (resolveInput(args.inputs.mp4boxPath, args) || "").toString().trim();

        if (!blHevc) {
            log(jobLog, "🚫 Missing BL DV8.1 video path (input: BL DV8.1 HEVC Path).");
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }
        if (!audioExportsFile) {
            log(jobLog, "🚫 Missing audio exports path (input: Audio Exports Path).");
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }
        if (!mp4boxPath) {
            log(jobLog, "🚫 Missing MP4Box path (input: MP4Box Path).");
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }

        if (!fs.existsSync(blHevc)) {
            log(jobLog, `🚫 BL DV8.1 video not found: ${blHevc}`);
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }

        if (!fs.existsSync(audioExportsFile)) {
            log(jobLog, `🚫 Audio exports not found: ${audioExportsFile}`);
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }

        const subtitleExists = subtitleExportsFile && fs.existsSync(subtitleExportsFile);
        if (userSubtitleExportsInput && !subtitleExists) {
            log(jobLog, `⚠ Subtitle exports path provided but file not found: ${subtitleExportsFile}`);
        }

        const rpuExists = rpuFilePath && fs.existsSync(rpuFilePath);
        if (userRpuInput && !rpuExists) {
            log(jobLog, `🚫 RPU file not found: ${rpuFilePath}`);
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }
        if (!userRpuInput && !rpuExists) {
            rpuFilePath = "";
        }

        const audioLines = fs.readFileSync(audioExportsFile, "utf-8").trim().split("\n");
        const subtitleLines = subtitleExists
            ? fs.readFileSync(subtitleExportsFile, "utf-8").trim().split("\n")
            : [];
        const deleteSources = String(resolveInput(args.inputs.deleteSourcesAfterRemux, args)) === "true";

        const audioBaseDir = path.dirname(audioExportsFile);
        const subBaseDir = subtitleExists ? path.dirname(subtitleExportsFile) : workDir;

        const outputFile = path.join(workDir, `${baseName}.mp4`);

        // Build MP4Box args list
        const mp4Args = ["-new", outputFile];

        // --- Video Track ---
        mp4Args.push("-add", `${blHevc}#video:dvp=8.1`);

        // --- Audio Tracks ---
        audioLines.forEach((line) => {
            const [filename, , newCodec, origCodec, delay, lang, title] = line.split("|");
            const filePath = path.join(audioBaseDir, filename);
            const langFlag = lang ? `:lang=${lang}` : "";

            // Convert delay from seconds to milliseconds for MP4Box
            const delaySeconds = parseFloat(delay || 0);
            const delayMs = Math.round(delaySeconds * 1000);
            const delayFlag = delayMs > 0 ? `:delay=${delayMs}` : "";

            const isConverted = newCodec !== origCodec;
            const convMark = isConverted ? " (Converted)" : "";
            const name = formatNameFlag(buildAudioTitle(title, lang, newCodec), convMark);

            mp4Args.push("-add", `${filePath}${langFlag}${delayFlag}${name}`);

            const delayInfo = delayMs > 0 ? ` | delay=${delaySeconds.toFixed(3)}s (${delayMs}ms)` : "";
            log(jobLog, `🎧 Audio: ${filename} | lang=${lang} | converted=${isConverted}${delayInfo}`);
        });

        // --- Subtitle Tracks ---
        subtitleLines.forEach((line) => {
            const [filename, , lang, codec, forced, title, hearingImpaired, visualImpaired, isDefault, isComment] = line.split("|");
            const srtPath = path.join(subBaseDir, filename);
            const langFlag = lang ? `:lang=${lang}` : "";
            const forcedFlag = forced === "1" ? ":forced" : "";

            const codecLower = (codec || "").toLowerCase();
            const isOcr = codecLower.includes("pgs") || codecLower.includes("hdmv");
            const convMark = isOcr ? " (OCR)" : "";
            const baseTitle = title || (lang ? lang.toUpperCase() : "Subtitle");
            const forcedMark = forced === "1" ? " (Forced)" : "";
            const hiMark = hearingImpaired === "1" ? " [SDH]" : "";
            const viMark = visualImpaired === "1" ? " [AD]" : "";
            const commentMark = isComment === "1" ? " [Commentary]" : "";
            const name = formatNameFlag(`${baseTitle}${forcedMark}${hiMark}${viMark}${commentMark}`, convMark);

            mp4Args.push("-add", `${srtPath}${langFlag}${forcedFlag}${name}`);
            log(jobLog, `💬 Subtitle: ${filename} | lang=${lang} | OCR=${isOcr} | forced=${forced === "1"} | HI=${hearingImpaired === "1"} | VI=${visualImpaired === "1"} | default=${isDefault === "1"} | comment=${isComment === "1"}`);
        });

        if (rpuFilePath) {
            log(jobLog, `ℹ RPU file provided: ${rpuFilePath} (not directly consumed by MP4Box command)`);
        }

        log(jobLog, `MP4Box: ${mp4boxPath} args: ${mp4Args.join(" ")}`);

        try {
            await runMP4Box(mp4boxPath, mp4Args);
        } catch (err) {
            console.error("🚨 MP4Box remux FAILED:", err.message);
            throw err;
        }

        log(jobLog, `🎉 SUCCESS — MP4 Created: ${outputFile}`);

        if (deleteSources) {
            log(jobLog, "🧹 Deleting source files used for remux...");

            const toDelete = new Set();
            toDelete.add(blHevc);
            toDelete.add(audioExportsFile);
            if (subtitleExists) toDelete.add(subtitleExportsFile);
            if (rpuFilePath) toDelete.add(rpuFilePath);

            audioLines.forEach((line) => {
                const [filename] = line.split("|");
                toDelete.add(path.join(audioBaseDir, filename));
            });

            subtitleLines.forEach((line) => {
                const [filename] = line.split("|");
                toDelete.add(path.join(subBaseDir, filename));
            });

            for (const filePath of toDelete) {
                if (!filePath) continue;
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        log(jobLog, `🗑 Deleted: ${filePath}`);
                    }
                } catch (err) {
                    log(jobLog, `⚠️ Failed to delete ${filePath}: ${err.message}`);
                }
            }
        }

        log(jobLog, "=== Final DV8.1 MP4Box Remux End ===");

        return {
            outputFileObj: {_id: outputFile},
            outputNumber: 1,
            variables: {
                ...args.variables,
                generatedMp4Path: outputFile
            }
        };
    };

    exports.plugin = plugin;

})();
