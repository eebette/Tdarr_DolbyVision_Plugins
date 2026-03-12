"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    /**
     * FFmpeg DV8.1 MP4 Remux Plugin
     * - Copies video stream bit-for-bit from input file
     * - Transcodes/copies audio streams directly from input file
     *   (TrueHD/DTS → EAC3, FLAC → ALAC, others copied as-is)
     * - Reads subtitles.exports metadata for subtitle tracks
     * - Remuxes everything to MP4 in a single ffmpeg command
     */

    const fs = require("fs");
    const path = require("path");
    const {spawn} = require("child_process");

    // Log helper (mirrors console + job log)
    function log(jobLog, msg) {
        jobLog(msg);
        console.log(msg);
    }

    // Maximum gap (in seconds) allowed between subtitle entries in an SRT file.
    // The MP4 muxer uses microsecond precision (1/1000000) for mov_text tracks.
    // Gaps longer than ~35.8 minutes exceed INT32_MAX microseconds, causing
    // "Packet duration is out of range" errors. We use 30 minutes as a safe limit.
    const MAX_SRT_GAP_SECONDS = 30 * 60;

    function parseSrtTime(str) {
        const m = str.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
        if (!m) return 0;
        return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
    }

    function formatSrtTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    }

    /**
     * Split any gaps in an SRT file that exceed MAX_SRT_GAP_SECONDS by inserting
     * invisible filler entries. This prevents the MP4 muxer from creating mov_text
     * packets with durations that overflow INT32_MAX at microsecond precision.
     * Returns true if the file was modified.
     */
    function splitLongSrtGaps(filePath, jobLog) {
        const content = fs.readFileSync(filePath, "utf-8");
        const blocks = content.trim().split(/\r?\n\r?\n/);
        const entries = [];
        for (const block of blocks) {
            const lines = block.trim().split(/\r?\n/);
            if (lines.length < 2) continue;
            const timeMatch = lines[1].match(/^(.+?)\s*-->\s*(.+?)$/);
            if (!timeMatch) continue;
            entries.push({
                start: parseSrtTime(timeMatch[1]),
                end: parseSrtTime(timeMatch[2]),
                text: lines.slice(2).join("\n"),
            });
        }

        if (entries.length === 0) return false;

        let needsFix = false;
        // Check gap before first entry (from time 0)
        if (entries[0].start > MAX_SRT_GAP_SECONDS) needsFix = true;
        for (let i = 1; i < entries.length && !needsFix; i++) {
            if (entries[i].start - entries[i - 1].end > MAX_SRT_GAP_SECONDS) {
                needsFix = true;
            }
        }
        if (!needsFix) return false;

        const newEntries = [];
        for (let i = 0; i < entries.length; i++) {
            const gapStart = i === 0 ? 0 : entries[i - 1].end;
            const gapEnd = entries[i].start;
            if (gapEnd - gapStart > MAX_SRT_GAP_SECONDS) {
                let t = gapStart + MAX_SRT_GAP_SECONDS;
                while (t < gapEnd - 1) {
                    newEntries.push({start: t, end: t + 0.001, text: ""});
                    t += MAX_SRT_GAP_SECONDS;
                }
            }
            newEntries.push(entries[i]);
        }

        const output = newEntries.map((e, idx) =>
            `${idx + 1}\n${formatSrtTime(e.start)} --> ${formatSrtTime(e.end)}\n${e.text}`
        ).join("\n\n") + "\n";

        fs.writeFileSync(filePath, output, "utf-8");
        const added = newEntries.length - entries.length;
        log(jobLog, `🔧 Split long subtitle gaps in: ${path.basename(filePath)} (${added} filler(s) added)`);
        return true;
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

    // Normalize codec name to a canonical form
    function normalizeCodec(codecName) {
        const codec = (codecName || "").toLowerCase();
        if (codec.includes("truehd")) return "truehd";
        if (codec.includes("eac3")) return "eac3";
        if (codec.includes("ac3")) return "ac3";
        if (codec.startsWith("dts")) return "dts";
        if (codec === "flac") return "flac";
        if (codec.startsWith("aac")) return "aac";
        return codec;
    }

    const SUPPORTED_AUDIO_CODECS = ["truehd", "eac3", "ac3", "dts", "flac", "aac"];

    // Build a sensible audio title when none was supplied
    function buildAudioTitle(title, lang, codec) {
        const cleaned = (title || "").trim();
        if (cleaned) return cleaned;

        const langPart = (lang || "").trim();
        const prettyLang = langPart ? langPart.toUpperCase() : "Audio";
        const labelMap = {
            eac3: "Dolby Digital Plus",
            ac3: "Dolby Digital",
            truehd: "TrueHD",
            dts: "DTS",
            flac: "FLAC",
            alac: "ALAC",
            aac: "AAC"
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
            const stderrLines = [];

            child.on("error", (err) => {
                reject(new Error(`Failed to start ffmpeg: ${err.message}`));
            });

            child.stdout.on("data", (data) => {
                console.log(`[ffmpeg] ${data.toString().trim()}`);
            });

            child.stderr.on("data", (data) => {
                const output = data.toString().trim();
                if (output) {
                    console.log(`[ffmpeg] ${output}`);
                    stderrLines.push(output);
                }
            });

            child.on("close", (code) => {
                if (code === 0) return resolve();
                const lastLines = stderrLines.slice(-20).join('\n');
                if (jobLog) {
                    jobLog(`🚨 FFmpeg stderr (last 20 lines):\n${lastLines}`);
                }
                reject(new Error(`ffmpeg exited with code ${code}\n${lastLines}`));
            });
        });
    }

    const details = () => ({
        name: "Build DV8.1 MP4 (FFmpeg)",
        description: "Remux video (bit-for-bit copy), transcode/copy audio, and add subtitles into MP4 using a single ffmpeg command. Replaces the need for a separate Extract Audio Tracks step.",
        style: {borderColor: "green"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 10,
        icon: "faFilm",
        inputs: [
            {
                label: "Convert TrueHD/DTS to EAC3",
                name: "convertTruehdDtsToEac3",
                tooltip: "Enable to transcode TrueHD/DTS audio tracks to EAC3 (Dolby Digital Plus). If disabled, these codecs will be copied as-is (may not be compatible with all MP4 players).",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
            {
                label: "Convert FLAC to ALAC",
                name: "convertFlacToAlac",
                tooltip: "Enable to transcode FLAC audio tracks to ALAC (Apple Lossless). Useful for MP4 containers which don't natively support FLAC in all players.",
                inputType: "boolean",
                defaultValue: "false",
                inputUI: { type: "switch" },
            },
            {
                label: "Subtitle Exports Path",
                name: "subtitleExportsPath",
                tooltip: "Path to subtitle exports manifest (from Extract All Subtitles). Leave empty to use Tdarr cache directory + <basename>_subtitles.exports.",
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
                tooltip: "Delete the subtitle exports and track files after remux completes.",
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

        const convertTruehdDtsToEac3 = String(resolveInput(args.inputs.convertTruehdDtsToEac3, args)) === "true";
        const convertFlacToAlac = String(resolveInput(args.inputs.convertFlacToAlac, args)) === "true";

        const userSubtitleExportsInput = (resolveInput(args.inputs.subtitleExportsPath, args) || "").toString().trim() || "";
        const subtitleExportsFile = userSubtitleExportsInput.length > 0
            ? userSubtitleExportsInput
            : path.join(args.workDir, `${baseName}_subtitles.exports`);

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const outputDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.workDir;

        // --- Audio: read streams directly from input file ---
        const streams = inputFileObj.ffProbeData?.streams || [];
        const audioStreams = streams.filter((s) => s.codec_type === "audio");

        if (!audioStreams.length) {
            log(jobLog, "⚠ No audio streams found in input file.");
        }

        // --- Subtitles: read from manifest (produced by Extract All Subtitles) ---
        const subtitleExists = subtitleExportsFile && fs.existsSync(subtitleExportsFile);
        if (userSubtitleExportsInput && !subtitleExists) {
            log(jobLog, `⚠ Subtitle exports path provided but file not found: ${subtitleExportsFile}`);
        }

        const subtitleLines = subtitleExists
            ? fs.readFileSync(subtitleExportsFile, "utf-8").trim().split("\n").filter(Boolean)
            : [];
        const deleteSources = String(resolveInput(args.inputs.deleteSourcesAfterRemux, args)) === "true";
        const subBaseDir = subtitleExists ? path.dirname(subtitleExportsFile) : args.workDir;

        const outputFile = path.join(outputDir, `${baseName}.mp4`);

        log(jobLog, `Input: ${inputPath}`);
        log(jobLog, `Output: ${outputFile}`);
        log(jobLog, `Audio streams: ${audioStreams.length} | Subtitle tracks: ${subtitleLines.length}`);
        log(jobLog, `Convert TrueHD/DTS → EAC3: ${convertTruehdDtsToEac3} | Convert FLAC → ALAC: ${convertFlacToAlac}`);

        // =====================================================================
        // Build ffmpeg command
        // =====================================================================

        // Input 0: source file (video + audio)
        const ffmpegArgs = ["-y", "-fflags", "+genpts", "-i", inputPath];

        // Pre-process SRT files: split any gaps > 30 min to prevent MP4 muxer overflow
        subtitleLines.forEach((line) => {
            const [filename] = line.split("|");
            const filePath = path.join(subBaseDir, filename);
            if (filePath.toLowerCase().endsWith(".srt") && fs.existsSync(filePath)) {
                splitLongSrtGaps(filePath, jobLog);
            }
        });

        // Inputs 1..N: subtitle files from manifest
        // Manifest format: file|index|lang|codec|delay|forced|title|hearing_impaired|visual_impaired|default|comment
        const subtitleFilePaths = [];
        subtitleLines.forEach((line) => {
            const [filename, , , , delay] = line.split("|");
            const filePath = path.join(subBaseDir, filename);
            const delaySeconds = parseFloat(delay || 0);
            subtitleFilePaths.push(filePath);

            // Apply delay offset to compensate for timestamp normalization during extraction
            if (delaySeconds !== 0) {
                ffmpegArgs.push("-itsoffset", delaySeconds.toString());
            }
            ffmpegArgs.push("-i", filePath);
        });

        // --- Stream mapping ---

        // Map video from input file
        ffmpegArgs.push("-map", "0:v:0");

        // Determine audio stream mapping and per-stream codec settings
        const audioTrackInfo = [];
        let needEac3Opts = false;

        for (const [inputIdx, s] of audioStreams.entries()) {
            const origCodecRaw = (s.codec_name || "").toLowerCase();
            const codec = normalizeCodec(origCodecRaw);

            if (!SUPPORTED_AUDIO_CODECS.includes(codec)) {
                log(jobLog, `Skipping a:${inputIdx}, unsupported codec: ${origCodecRaw}`);
                continue;
            }

            const lang = (s.tags?.language || "und").toLowerCase();
            const title = (s.tags?.title || "").replace(/\s*\|\s*/g, " / ");
            const outIdx = audioTrackInfo.length;

            let outCodec;
            let isConverted = false;

            // Map this audio stream from input file
            ffmpegArgs.push("-map", `0:a:${inputIdx}`);

            if ((codec === "truehd" || codec === "dts") && convertTruehdDtsToEac3) {
                // Transcode to EAC3
                outCodec = "eac3";
                isConverted = true;
                needEac3Opts = true;
                ffmpegArgs.push(`-c:a:${outIdx}`, "eac3");
                ffmpegArgs.push(`-b:a:${outIdx}`, "1024k");
                ffmpegArgs.push(`-filter:a:${outIdx}`, "aresample=async=1:first_pts=0");
            } else if (codec === "flac" && convertFlacToAlac) {
                // Transcode FLAC to ALAC
                outCodec = "alac";
                isConverted = true;
                ffmpegArgs.push(`-c:a:${outIdx}`, "alac");
            } else {
                // Copy as-is (eac3, ac3, aac, flac, or truehd/dts when convert is off)
                outCodec = codec;
                ffmpegArgs.push(`-c:a:${outIdx}`, "copy");
            }

            audioTrackInfo.push({inputIdx, outIdx, codec, outCodec, isConverted, lang, title});
        }

        // Map subtitle files (input indices start at 1 since input 0 is the source file)
        subtitleLines.forEach((_, idx) => {
            ffmpegArgs.push("-map", `${idx + 1}:s:0`);
        });

        // --- Codec settings ---

        // Video: bit-for-bit copy with hvc1 tag for HEVC in MP4
        ffmpegArgs.push("-c:v", "copy");
        ffmpegArgs.push("-tag:v", "hvc1");
        ffmpegArgs.push("-strict", "unofficial");

        // Global EAC3 encoder options (only relevant if any stream is being transcoded to EAC3)
        if (needEac3Opts) {
            ffmpegArgs.push(
                "-dialnorm", "-27",
                "-room_type", "0",
                "-mixing_level", "80",
                "-ad_conv_type", "0",
                "-stereo_rematrixing", "true",
                "-ltrt_cmixlev", "0.707",
                "-ltrt_surmixlev", "0.707",
                "-loro_cmixlev", "0.707",
                "-loro_surmixlev", "0.707"
            );
        }

        // Subtitles: convert to mov_text for MP4
        if (subtitleLines.length > 0) {
            ffmpegArgs.push("-c:s", "mov_text");
        }

        // --- Metadata ---

        // Audio track metadata
        for (const track of audioTrackInfo) {
            const {outIdx, codec, outCodec, isConverted, lang, title} = track;

            if (lang) {
                ffmpegArgs.push(`-metadata:s:a:${outIdx}`, `language=${lang}`);
            }

            const convMark = isConverted ? " (Converted)" : "";
            const trackTitle = buildAudioTitle(title, lang, outCodec) + convMark;

            ffmpegArgs.push(`-metadata:s:a:${outIdx}`, `title=${trackTitle}`);
            ffmpegArgs.push(`-metadata:s:a:${outIdx}`, `handler_name=${trackTitle}`);

            log(jobLog, `🎧 Audio ${outIdx}: a:${track.inputIdx} ${codec} → ${outCodec} | lang=${lang} | converted=${isConverted}`);
        }

        // Subtitle track metadata
        // Manifest format: file|index|lang|codec|delay|forced|title|hearing_impaired|visual_impaired|default|comment
        subtitleLines.forEach((line, idx) => {
            const [filename, , lang, codec, delay, forced, title, hearingImpaired, visualImpaired, isDefault, isComment] = line.split("|");

            if (lang) {
                ffmpegArgs.push(`-metadata:s:s:${idx}`, `language=${lang}`);
            }

            const codecLower = (codec || "").toLowerCase();
            const isOcr = codecLower.includes("pgs") || codecLower.includes("hdmv");
            const baseTitle = title || (lang ? lang.toUpperCase() : "Subtitle");
            const convMark = isOcr && !/\bocr\b/i.test(baseTitle) ? " (OCR)" : "";
            const forcedMark = forced === "1" && !/\bforced\b/i.test(baseTitle) ? " (Forced)" : "";
            const trackTitle = `${baseTitle}${forcedMark}${convMark}`;

            ffmpegArgs.push(`-metadata:s:s:${idx}`, `title=${trackTitle}`);
            ffmpegArgs.push(`-metadata:s:s:${idx}`, `handler_name=${trackTitle}`);

            const dispositions = [];
            if (forced === "1") dispositions.push("forced");
            if (hearingImpaired === "1") dispositions.push("hearing_impaired");
            if (visualImpaired === "1") dispositions.push("visual_impaired");
            if (isDefault === "1") dispositions.push("default");
            if (isComment === "1") dispositions.push("comment");
            if (dispositions.length > 0) {
                ffmpegArgs.push(`-disposition:s:${idx}`, dispositions.join("+"));
            }

            log(jobLog, `💬 Subtitle ${idx}: ${filename} | lang=${lang} | OCR=${isOcr} | forced=${forced === "1"} | HI=${hearingImpaired === "1"} | VI=${visualImpaired === "1"} | default=${isDefault === "1"} | comment=${isComment === "1"}`);
        });

        // --- Output ---
        ffmpegArgs.push("-f", "mp4");
        ffmpegArgs.push(outputFile);

        // =====================================================================
        // Run ffmpeg
        // =====================================================================
        try {
            await runFFmpeg(ffmpegArgs, jobLog);
        } catch (err) {
            console.error("🚨 FFmpeg remux FAILED:", err.message);
            throw err;
        }

        log(jobLog, `🎉 SUCCESS — MP4 Created: ${outputFile}`);

        // =====================================================================
        // Cleanup subtitle source files
        // =====================================================================
        if (deleteSources) {
            log(jobLog, "🧹 Deleting subtitle source files...");

            const toDelete = new Set();
            if (subtitleExists) toDelete.add(subtitleExportsFile);
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
