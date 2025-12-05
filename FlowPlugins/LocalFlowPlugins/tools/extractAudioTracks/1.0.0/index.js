"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    // DV7 → DV8.1 Audio Export Plugin (Async spawn version)
    // Implements original shell logic for audio export

    const fs = require("fs");
    const path = require("path");
    const { spawn } = require("child_process");

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

    function runFFmpeg(cmdArgs) {
        return new Promise((resolve, reject) => {
            const child = spawn("ffmpeg", cmdArgs, { stdio: "pipe" });

            child.on("error", (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
            child.stdout.on("data", (data) => console.log(`[ffmpeg] ${data.toString().trim()}`));
            child.stderr.on("data", (data) => {
                const output = data.toString().trim();
                // Filter out non-critical TrueHD/DTS timestamp warnings
                if (!output.includes("non monotonically increasing dts")) {
                    console.log(`[ffmpeg] ${output}`);
                }
            });
            child.on("close", (code) => {
                if (code === 0) return resolve();
                reject(new Error(`ffmpeg exited with code ${code}`));
            });
        });
    }

    function runMkvextract(mkvextractPath, cmdArgs) {
        return new Promise((resolve, reject) => {
            const child = spawn(mkvextractPath, cmdArgs, { stdio: "pipe" });

            child.on("error", (err) => reject(new Error(`Failed to start mkvextract: ${err.message}`)));
            child.stdout.on("data", (data) => console.log(`[mkvextract] ${data.toString().trim()}`));
            child.stderr.on("data", (data) => console.log(`[mkvextract] ${data.toString().trim()}`));
            child.on("close", (code) => {
                if (code === 0) return resolve();
                reject(new Error(`mkvextract exited with code ${code}`));
            });
        });
    }

    function getMkvTrackInfo(mkvmergePath, inputPath) {
        return new Promise((resolve, reject) => {
            const child = spawn(mkvmergePath, ["-J", inputPath], { stdio: "pipe" });

            let stdout = "";
            let stderr = "";

            child.on("error", (err) => reject(new Error(`Failed to start mkvmerge: ${err.message}`)));
            child.stdout.on("data", (data) => { stdout += data.toString(); });
            child.stderr.on("data", (data) => { stderr += data.toString(); });
            child.on("close", (code) => {
                if (code === 0) {
                    try {
                        const data = JSON.parse(stdout);
                        resolve(data);
                    } catch (err) {
                        reject(new Error(`Failed to parse mkvmerge JSON: ${err.message}`));
                    }
                } else {
                    reject(new Error(`mkvmerge exited with code ${code}: ${stderr}`));
                }
            });
        });
    }

    // Map ffprobe audio stream index to MKV track ID
    function mapAudioStreamToMkvTrack(audioStreamIndex, mkvData, audioStreams) {
        if (!mkvData || !mkvData.tracks) return null;

        // Get all audio tracks from MKV in order
        const mkvAudioTracks = mkvData.tracks.filter(t => t.type === "audio");

        // audioStreamIndex is the index within audioStreams array (0, 1, 2...)
        // Map to the corresponding MKV audio track
        if (audioStreamIndex < mkvAudioTracks.length) {
            return mkvAudioTracks[audioStreamIndex].id;
        }

        return null;
    }

    const details = () => ({
        name: "Extract Audio Tracks",
        description: "Export DV7 audio tracks to files (with optional EAC3 conversion).",
        style: { borderColor: "purple" },
        tags: "audio",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 5,
        icon: "faMusic",

        inputs: [
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory to place exported audio files. Leave empty to use the Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Convert TrueHD/DTS to EAC3",
                name: "convertTruehdDtsToEac3",
                tooltip: "Enable to transcode TrueHD/DTS audio tracks to EAC3 (default: enabled).",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
            {
                label: "mkvextract Path",
                name: "mkvextractPath",
                tooltip: "Path to mkvextract binary (used for extracting TrueHD from MKV). Leave empty to use path from Install DV Tools.",
                inputType: "string",
                defaultValue: "{{{args.variables.mkvextractBin}}}",
                inputUI: { type: "text" },
            },
            {
                label: "mkvmerge Path",
                name: "mkvmergePath",
                tooltip: "Path to mkvmerge binary (used to get MKV track IDs). Leave empty to use path from Install DV Tools or auto-detect.",
                inputType: "string",
                defaultValue: "{{{args.variables.mkvmergeBin}}}",
                inputUI: { type: "text" },
            }
        ],

        outputs: [{ number: 1, tooltip: "Continue to next step" }],
    });
    exports.details = details;

    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "=== DV7 Audio Export Plugin (Async) START ===");

        const inputPath = args.inputFileObj.file;
        const fileNameBase = args.inputFileObj.fileNameWithoutExtension;

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.librarySettings.cache;

        // Ensure workDir exists when overridden
        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating directory: ${workDir}`);
                fs.mkdirSync(workDir, { recursive: true });
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${workDir}`);
            console.error(err);
        }

        const streams = args.inputFileObj.ffProbeData?.streams || [];
        const audioStreams = streams.filter((s) => s.codec_type === "audio");

        if (!audioStreams.length) {
            log(jobLog, "No audio streams found — skipping.");
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 1,
                variables: { ...args.variables, audioExportsPath: null }
            };
        }

        const exportsPath = path.join(workDir, `${fileNameBase}_audio.exports`);
        if (fs.existsSync(exportsPath)) {
            try { fs.unlinkSync(exportsPath); } catch (_) {}
        }

        const convertTruehdDtsToEac3 = String(resolveInput(args.inputs.convertTruehdDtsToEac3, args)) === "true";

        // mkvextract/mkvmerge setup for TrueHD extraction from MKV
        const configuredMkvextractPath = (resolveInput(args.inputs.mkvextractPath, args) || "").toString().trim();
        // Try configured path, fall back to system installation
        const mkvextractPath = configuredMkvextractPath || "/usr/bin/mkvextract";

        // Auto-detect mkvmerge path from mkvextract path (same directory)
        const configuredMkvmergePath = (resolveInput(args.inputs.mkvmergePath, args) || "").toString().trim();
        const mkvmergePath = configuredMkvmergePath || path.join(path.dirname(mkvextractPath), "mkvmerge");

        const formatName = (args.inputFileObj.ffProbeData?.format?.format_name || "").toLowerCase();
        const isMkvContainer = formatName.includes("matroska") || formatName.includes("webm");
        const mkvextractAvailable = isMkvContainer && fs.existsSync(mkvextractPath);
        const mkvmergeAvailable = fs.existsSync(mkvmergePath);

        if (isMkvContainer && !fs.existsSync(mkvextractPath)) {
            log(jobLog, `⚠️ Input is MKV but mkvextract not found at: ${mkvextractPath}`);
            log(jobLog, `   Run "Install DV Tools" plugin first, or install mkvtoolnix system-wide.`);
            log(jobLog, `   TrueHD extraction will use ffmpeg (may have timestamp warnings)`);
        }

        // Get MKV track info if available
        let mkvTrackData = null;
        if (mkvextractAvailable && mkvmergeAvailable) {
            try {
                mkvTrackData = await getMkvTrackInfo(mkvmergePath, inputPath);
                log(jobLog, `✔ Retrieved MKV track info (${mkvTrackData.tracks.filter(t => t.type === "audio").length} audio tracks)`);
            } catch (err) {
                log(jobLog, `⚠️ Failed to get MKV track info: ${err.message}`);
                log(jobLog, `   Will fall back to ffmpeg for TrueHD extraction`);
            }
        }

        const manifestLines = [];
        // Input-side timing fixes (place before -i)
        const timingInputArgs = [
            "-fflags", "+genpts+igndts",
            "-avoid_negative_ts", "make_zero"
        ];
        // Output-side mux timing fixes (place before output file)
        const timingOutputArgs = ["-muxpreload", "0", "-muxdelay", "0"];
        // Extra hardening for TrueHD raw copies which are the most sensitive
        const truehdTimingOutputArgs = [...timingOutputArgs, "-max_interleave_delta", "500000"];

        for (const [id, s] of audioStreams.entries()) {
            const orig_codec_raw = (s.codec_name || "").toLowerCase();
            let orig_codec = orig_codec_raw;
            if (orig_codec.includes("truehd")) orig_codec = "truehd";
            else if (orig_codec.includes("eac3")) orig_codec = "eac3";
            else if (orig_codec.includes("ac3")) orig_codec = "ac3";
            else if (orig_codec.startsWith("dts")) orig_codec = "dts";
            else {
                log(jobLog, `Skipping a:${id}, unsupported codec: ${orig_codec_raw}`);
                continue;
            }

            const lang = (s.tags?.language || "und").toLowerCase();
            const title = (s.tags?.title || "").replace(/\s*\|\s*/g, " / ");
            const delay = 0;

            let outFile, outCodec, argsList;

            const basePrefix = `${fileNameBase}_${id}.${lang}`;
            const finaliseManifest = (file, codecOut) => {
                manifestLines.push([
                    file, id, codecOut, orig_codec, delay, lang, title
                ].join("|") + "\n");
            };

            const runExport = async (cmd, file, codecOut, label) => {
                const outPath = path.join(workDir, file);
                log(jobLog, `🎧 Export a:${id} ${orig_codec_raw} → ${file}${label ? " (" + label + ")" : ""}`);
                await runFFmpeg(cmd);
                if (!fs.existsSync(outPath)) {
                    throw new Error(`Expected output missing: ${outPath}`);
                }
                finaliseManifest(file, codecOut);
            };

            const runMkvExtract = async (audioStreamIndex, file, codecOut, label) => {
                const outPath = path.join(workDir, file);

                // Map ffprobe audio stream index to MKV track ID
                const mkvTrackId = mapAudioStreamToMkvTrack(audioStreamIndex, mkvTrackData, audioStreams);
                if (mkvTrackId === null) {
                    throw new Error(`Could not map audio stream ${audioStreamIndex} to MKV track ID`);
                }

                log(jobLog, `🎧 Export a:${id} ${orig_codec_raw} → ${file} (mkvextract track ${mkvTrackId})`);
                // mkvextract syntax: mkvextract source-file tracks trackId:output-file
                await runMkvextract(mkvextractPath, [inputPath, "tracks", `${mkvTrackId}:${outPath}`]);
                if (!fs.existsSync(outPath)) {
                    throw new Error(`Expected output missing: ${outPath}`);
                }
                finaliseManifest(file, codecOut);
            };

            if ((orig_codec === "truehd" || orig_codec === "dts") && convertTruehdDtsToEac3) {
                outFile = `${basePrefix}.eac3`;
                outCodec = "eac3";
                argsList = [
                    "-y", ...timingInputArgs, "-i", inputPath,
                    "-map", `0:a:${id}`,
                    "-filter:a:0", "aresample=async=1:first_pts=0",
                    "-b:a:0", "1024k",
                    "-c:a:0", "eac3", "-f", "eac3",
                    ...timingOutputArgs,
                    path.join(workDir, outFile)
                ];
            } else if (orig_codec === "eac3") {
                outFile = `${basePrefix}.eac3`;
                outCodec = "eac3";
                argsList = [
                    "-y", ...timingInputArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-c:a:0", "copy",
                    ...timingOutputArgs,
                    path.join(workDir, outFile)
                ];
            } else if (orig_codec === "ac3") {
                outFile = `${basePrefix}.ac3`;
                outCodec = "ac3";
                argsList = [
                    "-y", ...timingInputArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-c:a:0", "copy",
                    ...timingOutputArgs,
                    path.join(workDir, outFile)
                ];
            } else if (orig_codec === "truehd" || orig_codec === "dts") {
                outFile = `${basePrefix}.${orig_codec === "truehd" ? "thd" : "dts"}`;
                outCodec = orig_codec;

                // Use mkvextract for TrueHD from MKV to avoid timestamp issues
                if (orig_codec === "truehd" && mkvextractAvailable && mkvTrackData) {
                    try {
                        await runMkvExtract(id, outFile, outCodec);
                        continue; // Successfully extracted with mkvextract, move to next stream
                    } catch (mkvErr) {
                        log(jobLog, `⚠️ mkvextract failed for a:${id}: ${mkvErr.message}. Falling back to ffmpeg.`);
                        // Fall through to use ffmpeg as fallback
                    }
                }

                // Use ffmpeg for DTS or as fallback for TrueHD
                argsList = [
                    "-y", ...timingInputArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-c:a:0", "copy",
                    ...(orig_codec === "truehd"
                        ? ["-f", "truehd", ...truehdTimingOutputArgs]
                        : timingOutputArgs),
                    path.join(workDir, outFile)
                ];
            }

            if (!outFile || !argsList) continue;

            try {
                await runExport(argsList, outFile, outCodec);
            } catch (err) {
                // For TrueHD/DTS conversions, try a raw copy fallback
                if ((orig_codec === "truehd" || orig_codec === "dts") && convertTruehdDtsToEac3) {
                    try {
                        const copyFile = `${basePrefix}.${orig_codec === "truehd" ? "thd" : "dts"}`;

                        log(jobLog, `⚠️ EAC3 convert failed for a:${id} (${err.message}). Falling back to raw copy.`);

                        // Try mkvextract first for TrueHD from MKV
                        if (orig_codec === "truehd" && mkvextractAvailable && mkvTrackData) {
                            try {
                                await runMkvExtract(id, copyFile, orig_codec, "fallback mkvextract");
                                continue;
                            } catch (mkvErr) {
                                log(jobLog, `⚠️ mkvextract fallback also failed: ${mkvErr.message}. Trying ffmpeg.`);
                            }
                        }

                        // Use ffmpeg as final fallback
                        const copyCmd = [
                            "-y", ...timingInputArgs, "-i", inputPath,
                            "-map", `0:a:${id}`, "-c:a:0", "copy",
                            ...(orig_codec === "truehd"
                                ? ["-f", "truehd", ...truehdTimingOutputArgs]
                                : timingOutputArgs),
                            path.join(workDir, copyFile)
                        ];
                        await runExport(copyCmd, copyFile, orig_codec, "fallback ffmpeg copy");
                        continue;
                    } catch (fallbackErr) {
                        console.error(`🚨 Failed exporting a:${id} after fallback:`, fallbackErr.message);
                        throw fallbackErr;
                    }
                } else {
                    console.error(`🚨 Failed exporting a:${id}:`, err.message);
                    throw err;
                }
            }
        }

        if (manifestLines.length) {
            fs.writeFileSync(exportsPath, manifestLines.join(""));
        } else {
            log(jobLog, "⚠ No audio tracks exported; exports manifest not written.");
        }
        log(jobLog, "=== DV7 Audio Export Plugin (Async) END ===");

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();
