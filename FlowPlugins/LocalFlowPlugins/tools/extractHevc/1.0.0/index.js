"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    // ----------------------------------------
    // Requires (unchanged)
    // ----------------------------------------
    const fs = require("fs");
    const path = require("path");
    const { spawn } = require("child_process");

    // ----------------------------------------
    // Logging helper
    // ----------------------------------------
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

    // ----------------------------------------
    // FFmpeg runner (unchanged)
    // ----------------------------------------
    async function runFfmpeg(argsArray) {
        return new Promise((resolve, reject) => {
            const ff = spawn("ffmpeg", argsArray, { stdio: ["ignore", "pipe", "pipe"] });

            ff.on("error", (err) => {
                reject(new Error(`Failed to start ffmpeg: ${err.message}`));
            });

            ff.stdout.on("data", (data) => {
                console.log(`[ffmpeg] ${data.toString()}`);
            });

            ff.stderr.on("data", (data) => {
                console.log(`[ffmpeg] ${data.toString()}`);
            });

            ff.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg exited with code ${code}`));
            });
        });
    }

    // ----------------------------------------
    // Plugin Details (added one input)
    // ----------------------------------------
    const details = () => ({
        name: "Extract HEVC",
        description: "Extracts the primary HEVC track from the input file.",
        style: { borderColor: "purple" },
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 3,
        icon: "faFilm",

        inputs: [
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory to place extracted HEVC file. Leave empty to use the Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "x265 Preset (used for non-HEVC re-encode)",
                name: "x265Preset",
                tooltip: "Preset passed to libx265 when the source video is not already HEVC/H.265. Ignored when stream is copied. Default: slow.",
                inputType: "string",
                defaultValue: "slow",
                inputUI: { type: "text" },
            },
            {
                label: "x265 CRF (used for non-HEVC re-encode)",
                name: "x265Crf",
                tooltip: "CRF passed to libx265 when the source video is not already HEVC/H.265. Ignored when stream is copied. Default: 16.",
                inputType: "string",
                defaultValue: "16",
                inputUI: { type: "text" },
            }
        ],

        outputs: [{ number: 1, tooltip: "Continue to next step" }],
    });
    exports.details = details;

    // ----------------------------------------
    // Plugin Entrypoint
    // ----------------------------------------
    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "== Starting HEVC extraction ==");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const x265Preset = (resolveInput(args.inputs.x265Preset, args) || "").toString().trim() || "slow";
        const x265Crf = (resolveInput(args.inputs.x265Crf, args) || "").toString().trim() || "16";

        // Select output directory:
        // 1. Use configuredOutputDir if non-empty
        // 2. Otherwise fall back to existing logic
        const workDir =
            configuredOutputDir.length > 0
                ? configuredOutputDir
                : args.workDir;

        log(jobLog, `Working dir: ${workDir}`);

        // Ensure workDir exists
        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating directory: ${workDir}`);
                fs.mkdirSync(workDir, { recursive: true });
            } else {
                log(jobLog, `📂 Directory already exists: ${workDir}`);
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${workDir}`);
            console.error(err);
        }

        const baseName = path.basename(inputPath, path.extname(inputPath));
        log(jobLog, `Base filename: ${baseName}`);

        // Output HEVC path
        const blHevcPath = path.join(workDir, `${baseName}.hevc`);

        if (!fs.existsSync(blHevcPath)) {
            const streams = args?.inputFileObj?.ffProbeData?.streams;
            const videoStream = Array.isArray(streams) ? streams.find(s => s.codec_type === "video") : null;
            const codecName = (videoStream?.codec_name || "").toLowerCase();
            const codecTag = (videoStream?.codec_tag_string || "").toLowerCase();

            const isHevc =
                codecName.includes("hevc") ||
                codecName.includes("h265") ||
                codecName.includes("x265") ||
                codecTag.startsWith("hev") ||
                codecTag.startsWith("hvc") ||
                codecTag.startsWith("dvh") ||
                codecTag.startsWith("dvhe");

            if (isHevc) {
                log(jobLog, "🎬 Extracting HEVC track (stream copy)...");
                const copyArgs = [
                    "-i", inputPath,
                    "-c:v", "copy",
                    "-bsf:v", "hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9,hevc_mp4toannexb",
                    blHevcPath,
                ];

                log(jobLog, `📋 Command: ffmpeg ${copyArgs.join(' ')}`);
                await runFfmpeg(copyArgs);
            } else {
                log(jobLog, `🎬 Source video codec '${codecName || "unknown"}' is not HEVC. Re-encoding to HEVC with libx265 (preset=${x265Preset}, crf=${x265Crf})...`);
                const x265Params = `crf=${x265Crf}:aq-mode=3:aq-strength=1.0:psy-rd=2.0:psy-rdoq=1.0:deblock=-1,-1:hdr10-opt=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:repeat-headers=1`;
                const encodeArgs = [
                    "-i", inputPath,
                    "-map", "0:v:0",
                    "-an",
                    "-c:v", "libx265",
                    "-pix_fmt", "yuv420p10le",
                    "-preset", x265Preset,
                    "-x265-params", x265Params,
                    blHevcPath,
                ];

                log(jobLog, `📋 Command: ffmpeg ${encodeArgs.join(' ')}`);
                await runFfmpeg(encodeArgs);
            }
        } else {
            log(jobLog, `✔ Skipping HEVC extract, found: ${blHevcPath}`);
        }

        return {
            outputFileObj: inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    };

    exports.plugin = plugin;

})(); // END
