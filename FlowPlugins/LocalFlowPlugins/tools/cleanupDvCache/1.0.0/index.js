"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    /**
     * DV Cache Cleanup Plugin
     * - Deletes all DV processing cache files for the current file
     * - Includes BL HEVC, audio/subtitle exports and tracks, RPU, and output MP4
     */

    const fs = require("fs");
    const path = require("path");

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

    const details = () => ({
        name: "Cleanup DV Cache",
        description: "Delete all DV processing cache files (HEVC, audio/subtitle exports, RPU, MP4) for the current file.",
        style: { borderColor: "orange" },
        tags: "tools",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 10,
        icon: "faTrash",

        inputs: [
            {
                label: "Cache Directory",
                name: "cacheDirectory",
                tooltip: "Directory containing cache files. Leave empty to use Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Delete Output MP4",
                name: "deleteOutputMp4",
                tooltip: "Also delete the output MP4 file (default: disabled).",
                inputType: "boolean",
                defaultValue: "false",
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
        log(jobLog, "=== DV Cache Cleanup Plugin START ===");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        const configuredCacheDir = (resolveInput(args.inputs.cacheDirectory, args) || "").toString().trim() || "";
        const cacheDir = configuredCacheDir.length > 0 ? configuredCacheDir : args.workDir;
        const deleteOutputMp4 = String(resolveInput(args.inputs.deleteOutputMp4, args)) === "true";

        log(jobLog, `📂 Cache directory: ${cacheDir}`);
        log(jobLog, `📝 Base name: ${baseName}`);

        const toDelete = new Set();
        let deletedCount = 0;
        let skippedCount = 0;

        // --- Primary cache files ---
        const primaryFiles = [
            { path: path.join(cacheDir, `${baseName}.hevc`), description: "BL HEVC" },
            { path: path.join(cacheDir, `${baseName}_audio.exports`), description: "Audio exports manifest" },
            { path: path.join(cacheDir, `${baseName}_subtitles.exports`), description: "Subtitle exports manifest" },
            { path: path.join(cacheDir, `${baseName}_RPU.bin`), description: "RPU file" },
        ];

        if (deleteOutputMp4) {
            primaryFiles.push({ path: path.join(cacheDir, `${baseName}.mp4`), description: "Output MP4" });
        }

        for (const file of primaryFiles) {
            if (fs.existsSync(file.path)) {
                toDelete.add(file.path);
                log(jobLog, `✓ Found: ${file.description} - ${path.basename(file.path)}`);
            }
        }

        // --- Audio track files from manifest ---
        const audioExportsFile = path.join(cacheDir, `${baseName}_audio.exports`);
        if (fs.existsSync(audioExportsFile)) {
            try {
                const audioLines = fs.readFileSync(audioExportsFile, "utf-8").trim().split("\n").filter(Boolean);
                audioLines.forEach((line) => {
                    const [filename] = line.split("|");
                    if (filename) {
                        const audioFilePath = path.join(cacheDir, filename);
                        if (fs.existsSync(audioFilePath)) {
                            toDelete.add(audioFilePath);
                            log(jobLog, `✓ Found audio track: ${filename}`);
                        }
                    }
                });
            } catch (err) {
                log(jobLog, `⚠️ Failed to read audio exports manifest: ${err.message}`);
            }
        }

        // --- Subtitle track files from manifest ---
        const subtitleExportsFile = path.join(cacheDir, `${baseName}_subtitles.exports`);
        if (fs.existsSync(subtitleExportsFile)) {
            try {
                const subtitleLines = fs.readFileSync(subtitleExportsFile, "utf-8").trim().split("\n").filter(Boolean);
                subtitleLines.forEach((line) => {
                    const [filename] = line.split("|");
                    if (filename) {
                        const subtitleFilePath = path.join(cacheDir, filename);
                        if (fs.existsSync(subtitleFilePath)) {
                            toDelete.add(subtitleFilePath);
                            log(jobLog, `✓ Found subtitle track: ${filename}`);
                        }
                    }
                });
            } catch (err) {
                log(jobLog, `⚠️ Failed to read subtitle exports manifest: ${err.message}`);
            }
        }

        // --- Delete all collected files ---
        if (toDelete.size === 0) {
            log(jobLog, "ℹ️ No cache files found to delete.");
        } else {
            log(jobLog, `🗑️ Deleting ${toDelete.size} cache file(s)...`);

            for (const filePath of toDelete) {
                if (!filePath) continue;
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        deletedCount++;
                        log(jobLog, `  ✓ Deleted: ${path.basename(filePath)}`);
                    } else {
                        skippedCount++;
                        log(jobLog, `  ⚠️ Skipped (not found): ${path.basename(filePath)}`);
                    }
                } catch (err) {
                    skippedCount++;
                    log(jobLog, `  ❌ Failed to delete ${path.basename(filePath)}: ${err.message}`);
                }
            }

            log(jobLog, `✅ Deleted: ${deletedCount} file(s)`);
            if (skippedCount > 0) {
                log(jobLog, `⚠️ Skipped/Failed: ${skippedCount} file(s)`);
            }
        }

        log(jobLog, "=== DV Cache Cleanup Plugin END ===");

        return {
            outputFileObj: inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();
