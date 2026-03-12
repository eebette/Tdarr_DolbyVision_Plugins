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
     * - Step 1: FFmpeg remuxes video + audio to MP4 (no subtitles)
     * - Step 2: MP4Box adds subtitle tracks to the MP4
     *   (ffmpeg's MP4 muxer uses microsecond timescale for mov_text, causing
     *    INT32_MAX overflow on content > ~36 minutes — MP4Box handles this correctly)
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

    function runProcess(cmd, cmdArgs, jobLog, label) {
        return new Promise((resolve, reject) => {
            const cmdStr = `${cmd} ${cmdArgs.join(' ')}`;
            console.log(`📋 ${label} Command: ${cmdStr}`);
            if (jobLog) {
                jobLog(`📋 ${label} Command: ${cmdStr}`);
            }

            const child = spawn(cmd, cmdArgs, {
                stdio: "pipe",
                env: {
                    ...process.env,
                    LD_LIBRARY_PATH: `/home/Tdarr/opt/gpac/usr/lib:${process.env.LD_LIBRARY_PATH || ""}`
                }
            });
            const stderrLines = [];

            child.on("error", (err) => {
                reject(new Error(`Failed to start ${label}: ${err.message}`));
            });

            child.stdout.on("data", (data) => {
                console.log(`[${label}] ${data.toString().trim()}`);
            });

            child.stderr.on("data", (data) => {
                const output = data.toString().trim();
                if (output) {
                    console.log(`[${label}] ${output}`);
                    stderrLines.push(output);
                }
            });

            child.on("close", (code) => {
                if (code === 0) return resolve();
                const lastLines = stderrLines.slice(-20).join('\n');
                if (jobLog) {
                    jobLog(`🚨 ${label} stderr (last 20 lines):\n${lastLines}`);
                }
                reject(new Error(`${label} exited with code ${code}\n${lastLines}`));
            });
        });
    }

    const details = () => ({
        name: "Build DV8.1 MP4 (FFmpeg)",
        description: "Remux video (bit-for-bit copy), transcode/copy audio into MP4 via FFmpeg, then add subtitles via MP4Box. Replaces the need for a separate Extract Audio Tracks step.",
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
        // Step 1: FFmpeg — remux video + audio only (no subtitles)
        // =====================================================================
        // Subtitles are added separately via MP4Box because ffmpeg's MP4 muxer
        // uses microsecond timescale (1/1000000) for mov_text subtitle tracks,
        // causing INT32_MAX overflow on content longer than ~36 minutes.

        const ffmpegArgs = ["-y", "-fflags", "+genpts", "-i", inputPath];

        // Map video
        ffmpegArgs.push("-map", "0:v:0");

        // Map and configure audio streams
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

            ffmpegArgs.push("-map", `0:a:${inputIdx}`);

            if ((codec === "truehd" || codec === "dts") && convertTruehdDtsToEac3) {
                outCodec = "eac3";
                isConverted = true;
                needEac3Opts = true;
                ffmpegArgs.push(`-c:a:${outIdx}`, "eac3");
                ffmpegArgs.push(`-b:a:${outIdx}`, "1024k");
                ffmpegArgs.push(`-filter:a:${outIdx}`, "aresample=async=1:first_pts=0");
            } else if (codec === "flac" && convertFlacToAlac) {
                outCodec = "alac";
                isConverted = true;
                ffmpegArgs.push(`-c:a:${outIdx}`, "alac");
            } else {
                outCodec = codec;
                ffmpegArgs.push(`-c:a:${outIdx}`, "copy");
            }

            audioTrackInfo.push({inputIdx, outIdx, codec, outCodec, isConverted, lang, title});
        }

        // No subtitle mapping — subtitles will be added by MP4Box in step 2

        // Video: bit-for-bit copy with hvc1 tag for HEVC in MP4
        ffmpegArgs.push("-c:v", "copy");
        ffmpegArgs.push("-tag:v", "hvc1");
        ffmpegArgs.push("-strict", "unofficial");

        // Global EAC3 encoder options
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

        ffmpegArgs.push("-f", "mp4");
        ffmpegArgs.push(outputFile);

        try {
            await runProcess("ffmpeg", ffmpegArgs, jobLog, "ffmpeg");
        } catch (err) {
            console.error("🚨 FFmpeg remux FAILED:", err.message);
            throw err;
        }

        log(jobLog, `✅ FFmpeg step complete — video + audio muxed to: ${outputFile}`);

        // =====================================================================
        // Step 2: MP4Box — add subtitle tracks
        // =====================================================================
        // MP4Box properly handles subtitle timescales, avoiding the INT32_MAX
        // overflow that plagues ffmpeg's mov_text encoder on long content.

        const subtitleFilePaths = [];

        if (subtitleLines.length > 0) {
            const mp4boxPath = (args.variables?.mp4boxBin || "").trim() || "/home/Tdarr/opt/gpac/usr/bin/MP4Box";

            log(jobLog, `📎 Adding ${subtitleLines.length} subtitle track(s) via MP4Box...`);

            // Manifest format: file|index|lang|codec|delay|forced|title|hearing_impaired|visual_impaired|default|comment
            for (const line of subtitleLines) {
                const [filename, , lang, codec, delay, forced, title, hearingImpaired, visualImpaired, isDefault, isComment] = line.split("|");
                const srtPath = path.join(subBaseDir, filename);
                subtitleFilePaths.push(srtPath);

                const langFlag = lang ? `:lang=${lang}` : "";
                const forcedFlag = forced === "1" ? ":forced" : "";

                const delaySeconds = parseFloat(delay || 0);
                const delayMs = Math.round(delaySeconds * 1000);
                const delayFlag = delayMs !== 0 ? `:delay=${delayMs}` : "";

                const codecLower = (codec || "").toLowerCase();
                const isOcr = codecLower.includes("pgs") || codecLower.includes("hdmv");
                const baseTitle = title || (lang ? lang.toUpperCase() : "Subtitle");
                const convMark = isOcr && !/\bocr\b/i.test(baseTitle) ? " (OCR)" : "";
                const forcedMark = forced === "1" && !/\bforced\b/i.test(baseTitle) ? " (Forced)" : "";
                const hiMark = hearingImpaired === "1" && !/\bsdh\b/i.test(baseTitle) ? " [SDH]" : "";
                const viMark = visualImpaired === "1" && !/\bad\b/i.test(baseTitle) ? " [AD]" : "";
                const commentMark = isComment === "1" && !/\bcommentary\b/i.test(baseTitle) ? " [Commentary]" : "";
                const trackTitle = `${baseTitle}${forcedMark}${hiMark}${viMark}${commentMark}${convMark}`;
                const nameFlag = `:name=${trackTitle}`;

                const mp4Args = ["-add", `${srtPath}${langFlag}${forcedFlag}${delayFlag}${nameFlag}`, outputFile];

                log(jobLog, `💬 Subtitle: ${filename} | lang=${lang} | OCR=${isOcr} | forced=${forced === "1"} | HI=${hearingImpaired === "1"} | VI=${visualImpaired === "1"} | default=${isDefault === "1"} | comment=${isComment === "1"}`);

                try {
                    await runProcess(mp4boxPath, mp4Args, jobLog, "MP4Box");
                } catch (err) {
                    log(jobLog, `⚠️ MP4Box subtitle add failed for ${filename}: ${err.message}`);
                    // Continue with remaining subtitles — don't fail the entire remux
                }
            }

            log(jobLog, `✅ MP4Box step complete — subtitles added`);
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
