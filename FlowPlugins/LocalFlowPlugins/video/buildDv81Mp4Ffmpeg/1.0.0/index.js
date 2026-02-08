"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    /**
     * FFmpeg DV8.1 MP4 Remux Plugin
     * - Copies video stream bit-for-bit from input file
     * - Reads audio.exports + subtitles.exports metadata
     * - Remuxes to MP4 with ffmpeg instead of MP4Box
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

    function runFFmpeg(ffmpegArgs, jobLog) {
        return new Promise((resolve, reject) => {
            const cmdStr = `ffmpeg ${ffmpegArgs.join(' ')}`;
            console.log(`📋 Command: ${cmdStr}`);
            if (jobLog) {
                jobLog(`📋 Command: ${cmdStr}`);
            }

            const child = spawn("ffmpeg", ffmpegArgs, {stdio: "pipe"});

            child.on("error", (err) => {
                reject(new Error(`Failed to start ffmpeg: ${err.message}`));
            });

            child.stdout.on("data", (data) => {
                console.log(`[ffmpeg] ${data.toString().trim()}`);
            });

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
        name: "Build DV8.1 MP4 (FFmpeg)",
        description: "Remux input video (copied bit-for-bit), audio, and subtitles into MP4 using ffmpeg.",
        style: {borderColor: "green"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 10,
        icon: "faFilm",
        inputs: [
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
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Directory for output MP4. Leave empty to use Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Delete Sources After Remux",
                name: "deleteSourcesAfterRemux",
                tooltip: "Delete the audio/subtitle exports and track files after remux completes.",
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
        log(jobLog, "=== DV8.1 MP4 FFmpeg Remux Start ===");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        const audioExportsFile = (resolveInput(args.inputs.audioExportsPath, args)?.toString().trim()) ||
            path.join(args.workDir, `${baseName}_audio.exports`);

        const userSubtitleExportsInput = (resolveInput(args.inputs.subtitleExportsPath, args) || "").toString().trim() || "";
        const subtitleExportsFile = userSubtitleExportsInput.length > 0
            ? userSubtitleExportsInput
            : path.join(args.workDir, `${baseName}_subtitles.exports`);

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const outputDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.workDir;

        if (!fs.existsSync(audioExportsFile)) {
            log(jobLog, `🚫 Audio exports not found: ${audioExportsFile}`);
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables};
        }

        const subtitleExists = subtitleExportsFile && fs.existsSync(subtitleExportsFile);
        if (userSubtitleExportsInput && !subtitleExists) {
            log(jobLog, `⚠ Subtitle exports path provided but file not found: ${subtitleExportsFile}`);
        }

        const audioLines = fs.readFileSync(audioExportsFile, "utf-8").trim().split("\n").filter(Boolean);
        const subtitleLines = subtitleExists
            ? fs.readFileSync(subtitleExportsFile, "utf-8").trim().split("\n").filter(Boolean)
            : [];
        const deleteSources = String(resolveInput(args.inputs.deleteSourcesAfterRemux, args)) === "true";

        const audioBaseDir = path.dirname(audioExportsFile);
        const subBaseDir = subtitleExists ? path.dirname(subtitleExportsFile) : args.workDir;

        // Ensure output file has .mp4 extension (baseName has no extension)
        const outputFile = path.join(outputDir, `${baseName}.mp4`);

        log(jobLog, `Input: ${inputPath}`);
        log(jobLog, `Output: ${outputFile}`);

        // Build ffmpeg args list
        const ffmpegArgs = ["-y", "-fflags", "+genpts", "-i", inputPath];

        // Add all audio input files
        const audioFilePaths = [];
        const audioDelays = [];
        audioLines.forEach((line) => {
            const [filename, , , , delay] = line.split("|");
            const filePath = path.join(audioBaseDir, filename);
            const delaySeconds = parseFloat(delay || 0);
            audioFilePaths.push(filePath);
            audioDelays.push(delaySeconds);

            // Apply delay offset if needed
            if (delaySeconds > 0) {
                ffmpegArgs.push("-itsoffset", delaySeconds.toString());
            }
            ffmpegArgs.push("-i", filePath);
            // Reset itsoffset after each audio input to prevent affecting subsequent inputs
            if (delaySeconds > 0) {
                ffmpegArgs.push("-itsoffset", "0");
            }
        });

        // Add all subtitle input files
        const subtitleFilePaths = [];
        subtitleLines.forEach((line) => {
            const [filename] = line.split("|");
            const filePath = path.join(subBaseDir, filename);
            subtitleFilePaths.push(filePath);
            ffmpegArgs.push("-i", filePath);
        });

        // Map video from input file (index 0)
        ffmpegArgs.push("-map", "0:v:0");

        // Map all audio files (starting from index 1)
        audioLines.forEach((_, idx) => {
            ffmpegArgs.push("-map", `${idx + 1}:a:0`);
        });

        // Map all subtitle files (starting after audio files)
        subtitleLines.forEach((_, idx) => {
            ffmpegArgs.push("-map", `${audioLines.length + idx + 1}:s:0`);
        });

        // Set codecs
        ffmpegArgs.push("-c:v", "copy");
        ffmpegArgs.push("-tag:v", "hvc1");
        ffmpegArgs.push("-strict", "unofficial");
        ffmpegArgs.push("-c:a", "copy");
        ffmpegArgs.push("-c:s", "mov_text");

        // Add metadata for each audio track
        audioLines.forEach((line, idx) => {
            const [filename, , newCodec, origCodec, delay, lang, title] = line.split("|");

            if (lang) {
                ffmpegArgs.push(`-metadata:s:a:${idx}`, `language=${lang}`);
            }

            const isConverted = newCodec !== origCodec;
            const convMark = isConverted ? " (Converted)" : "";
            const trackTitle = buildAudioTitle(title, lang, newCodec) + convMark;

            ffmpegArgs.push(`-metadata:s:a:${idx}`, `title=${trackTitle}`);

            const delaySeconds = parseFloat(delay || 0);
            const delayInfo = delaySeconds > 0 ? ` | delay=${delaySeconds.toFixed(3)}s` : "";
            log(jobLog, `🎧 Audio ${idx}: ${filename} | lang=${lang} | converted=${isConverted}${delayInfo}`);
        });

        // Add metadata for each subtitle track
        subtitleLines.forEach((line, idx) => {
            const [filename, , lang, codec, forced, title, hearingImpaired, visualImpaired, isDefault, isComment] = line.split("|");

            if (lang) {
                ffmpegArgs.push(`-metadata:s:s:${idx}`, `language=${lang}`);
            }

            const isConverted = codec && codec.toLowerCase() === "srt";
            const baseTitle = title || (lang ? lang.toUpperCase() : "Subtitle");
            const convMark = isConverted && !/\bocr\b/i.test(baseTitle) ? " (OCR)" : "";
            const forcedMark = forced === "1" && !/\bforced\b/i.test(baseTitle) ? " (Forced)" : "";
            const trackTitle = `${baseTitle}${forcedMark}${convMark}`;

            ffmpegArgs.push(`-metadata:s:s:${idx}`, `title=${trackTitle}`);

            const dispositions = [];
            if (forced === "1") dispositions.push("forced");
            if (hearingImpaired === "1") dispositions.push("hearing_impaired");
            if (visualImpaired === "1") dispositions.push("visual_impaired");
            if (isDefault === "1") dispositions.push("default");
            if (isComment === "1") dispositions.push("comment");
            if (dispositions.length > 0) {
                ffmpegArgs.push(`-disposition:s:${idx}`, dispositions.join("+"));
            }

            log(jobLog, `💬 Subtitle ${idx}: ${filename} | lang=${lang} | OCR=${isConverted} | forced=${forced === "1"} | HI=${hearingImpaired === "1"} | VI=${visualImpaired === "1"} | default=${isDefault === "1"} | comment=${isComment === "1"}`);
        });

        // Force MP4 output format
        ffmpegArgs.push("-f", "mp4");

        // Output file
        ffmpegArgs.push(outputFile);

        try {
            await runFFmpeg(ffmpegArgs, jobLog);
        } catch (err) {
            console.error("🚨 FFmpeg remux FAILED:", err.message);
            throw err;
        }

        log(jobLog, `🎉 SUCCESS — MP4 Created: ${outputFile}`);

        if (deleteSources) {
            log(jobLog, "🧹 Deleting source files used for remux...");

            const toDelete = new Set();
            toDelete.add(audioExportsFile);
            if (subtitleExists) toDelete.add(subtitleExportsFile);

            audioFilePaths.forEach(file => toDelete.add(file));
            subtitleFilePaths.forEach(file => toDelete.add(file));

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

        log(jobLog, "=== DV8.1 MP4 FFmpeg Remux End ===");

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
