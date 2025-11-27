"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    /**
     * MP4Box DV5 MP4 Remux Plugin
     * - Reads audio.exports + subtitles.exports metadata
     * - Builds an MP4 (dvp=5) with track names and language flags
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
        name: "Build DV5 MP4",
        description: "Remux DV5 BL, audio, and subtitles into MP4 (dvp=5) via MP4Box.",
        style: {borderColor: "purple"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 9,
        icon: "faFilm",
        inputs: [
            {
                label: "BL DV5 HEVC Path",
                name: "blDv5HevcPath",
                tooltip: "Path to BL DV5 HEVC file. Leave empty to use Tdarr cache directory + <basename>.hevc.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Audio Exports Path",
                name: "audioExportsPath",
                tooltip: "Path to audio exports manifest. Leave empty to use Tdarr cache directory + <basename>_audio.exports.",
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
                tooltip: "Delete the source files used to build the MP4 after remux completes.",
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
        log(jobLog, "=== DV5 MP4 Remux Plugin Start ===");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        const blHevc =
            (resolveInput(args.inputs.blDv5HevcPath, args)?.toString().trim()) ||
            path.join(args.librarySettings.cache, `${baseName}.hevc`);

        const audioExportsFile =
            (resolveInput(args.inputs.audioExportsPath, args)?.toString().trim()) ||
            path.join(args.librarySettings.cache, `${baseName}_audio.exports`);

        const subtitleExportsFile =
            (resolveInput(args.inputs.subtitleExportsPath, args)?.toString().trim()) ||
            path.join(args.librarySettings.cache, `${baseName}_subtitles.exports`);
        const subtitleExists = fs.existsSync(subtitleExportsFile);

        const mp4boxPath = (resolveInput(args.inputs.mp4boxPath, args) || "").toString().trim();
        const deleteSources = String(resolveInput(args.inputs.deleteSourcesAfterRemux, args)) === "true";

        const audioBaseDir = path.dirname(audioExportsFile);
        const subBaseDir = subtitleExists ? path.dirname(subtitleExportsFile) : args.librarySettings.cache;

        const outputFile = path.join(args.librarySettings.cache, `${baseName}.mp4`);

        // Build MP4Box args list
        const mp4Args = ["-new", outputFile];

        // --- Video Track (DV5) ---
        mp4Args.push("-add", `${blHevc}:dvp=5`);

        // --- Audio Tracks ---
        const audioLines = fs.existsSync(audioExportsFile)
            ? fs.readFileSync(audioExportsFile, "utf-8").trim().split("\n").filter(Boolean)
            : [];
        audioLines.forEach((line) => {
            const [filename, , newCodec, origCodec, , lang, title] = line.split("|");
            const filePath = path.join(audioBaseDir, filename);
            const langFlag = lang ? `:lang=${lang}` : "";

            const isConverted = newCodec !== origCodec;
            const convMark = isConverted ? " (Converted)" : "";
            const name = formatNameFlag(title, convMark);

            mp4Args.push("-add", `${filePath}${langFlag}${name}`);
            log(jobLog, `🎧 Audio: ${filename} | lang=${lang} | converted=${isConverted}`);
        });

        // --- Subtitle Tracks ---
        if (subtitleExists) {
            const subtitleLines = fs.readFileSync(subtitleExportsFile, "utf-8").trim().split("\n").filter(Boolean);
            subtitleLines.forEach((line) => {
                const [filename, , lang, codec, forced, title] = line.split("|");
                const srtPath = path.join(subBaseDir, filename);
                const langFlag = lang ? `:lang=${lang}` : "";
                const forcedFlag = forced === "1" ? ":forced" : "";

                const isConverted = codec && codec.toLowerCase() === "srt";
                const convMark = isConverted ? " (OCR)" : "";
                const name = formatNameFlag(title, convMark);

                mp4Args.push("-add", `${srtPath}${langFlag}${forcedFlag}${name}`);
                log(jobLog, `💬 Subtitle: ${filename} | lang=${lang} | OCR=${isConverted}`);
            });
        }

        log(jobLog, `MP4Box: ${mp4boxPath} args: ${mp4Args.join(" ")}`);

        try {
            await runMP4Box(mp4boxPath, mp4Args);
        } catch (err) {
            console.error("🚨 MP4Box DV5 remux FAILED:", err.message);
            return {outputFileObj: inputFileObj, outputNumber: 1, variables: args.variables, error: err.message};
        }

        log(jobLog, `🎉 SUCCESS — MP4 Created: ${outputFile}`);

        if (deleteSources) {
            log(jobLog, "🧹 Deleting source files used for remux...");

            const toDelete = new Set();
            toDelete.add(blHevc);
            toDelete.add(audioExportsFile);
            if (subtitleExists) {
                toDelete.add(subtitleExportsFile);
                fs.readFileSync(subtitleExportsFile, "utf-8").trim().split("\n").filter(Boolean).forEach((line) => {
                    const [filename] = line.split("|");
                    toDelete.add(path.join(subBaseDir, filename));
                });
            }
            toDelete.forEach((file) => {
                try {
                    if (file && fs.existsSync(file)) {
                        fs.unlinkSync(file);
                        log(jobLog, `🗑️ Deleted: ${file}`);
                    }
                } catch (err) {
                    log(jobLog, `⚠️ Failed to delete ${file}: ${err.message}`);
                }
            });
        }

        return {
            outputFileObj: inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();  // END WRAPPER
