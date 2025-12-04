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
            child.stderr.on("data", (data) => console.log(`[ffmpeg] ${data.toString().trim()}`));
            child.on("close", (code) => {
                if (code === 0) return resolve();
                reject(new Error(`ffmpeg exited with code ${code}`));
            });
        });
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
                inputType: "boolean", // binary toggle
                defaultValue: "true",
                inputUI: { type: "switch" },
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

        const manifestLines = [];
        // Force ffmpeg to regenerate timestamps so TrueHD copies don't spam non‑monotonic DTS errors
        const timingArgs = ["-fflags", "+genpts", "-avoid_negative_ts", "make_zero"];

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

            if ((orig_codec === "truehd" || orig_codec === "dts") && convertTruehdDtsToEac3) {
                outFile = `${basePrefix}.eac3`;
                outCodec = "eac3";
                argsList = [
                    "-y", ...timingArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-b:a:0", "1024k",
                    "-c:a:0", "eac3", "-f", "eac3",
                    path.join(workDir, outFile)
                ];
            } else if (orig_codec === "eac3") {
                outFile = `${basePrefix}.eac3`;
                outCodec = "eac3";
                argsList = [
                    "-y", ...timingArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-c:a:0", "copy",
                    path.join(workDir, outFile)
                ];
            } else if (orig_codec === "ac3") {
                outFile = `${basePrefix}.ac3`;
                outCodec = "ac3";
                argsList = [
                    "-y", ...timingArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-c:a:0", "copy",
                    path.join(workDir, outFile)
                ];
            } else if (orig_codec === "truehd" || orig_codec === "dts") {
                outFile = `${basePrefix}.${orig_codec === "truehd" ? "thd" : "dts"}`;
                outCodec = orig_codec;
                argsList = [
                    "-y", ...timingArgs, "-i", inputPath,
                    "-map", `0:a:${id}`, "-c:a:0", "copy",
                    ...(orig_codec === "truehd" ? ["-f", "truehd"] : []),
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
                        const copyCmd = [
                            "-y", ...timingArgs, "-i", inputPath,
                            "-map", `0:a:${id}`, "-c:a:0", "copy",
                            ...(orig_codec === "truehd" ? ["-f", "truehd"] : []),
                            path.join(workDir, copyFile)
                        ];
                        log(jobLog, `⚠️ EAC3 convert failed for a:${id} (${err.message}). Falling back to raw copy.`);
                        await runExport(copyCmd, copyFile, orig_codec, "fallback copy");
                        continue;
                    } catch (fallbackErr) {
                        console.error(`🚨 Failed exporting a:${id} after fallback:`, fallbackErr.message);
                    }
                } else {
                    console.error(`🚨 Failed exporting a:${id}:`, err.message);
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
