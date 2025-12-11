"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    // HEVC → DV Converter (Async spawn version)
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

    function runSpawn(command, args) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {stdio: "pipe"});

            child.on("error", (err) => {
                reject(new Error(`Failed to start ${command}: ${err.message}`));
            });

            child.stdout.on("data", (data) => {
                const msg = data.toString().trim();
                if (msg) console.log(`[dovi_tool]: ${msg}`);
            });

            child.stderr.on("data", (data) => {
                const msg = data.toString().trim();
                if (msg) console.warn(`[dovi_tool ERR]: ${msg}`);
            });

            child.on("close", (code) => {
                if (code === 0) return resolve();
                reject(new Error(`dovi_tool exited with code ${code}`));
            });
        });
    }

    const details = () => ({
        name: "Convert HEVC with dovi_tool",
        description: "Convert an HEVC bitstream using dovi_tool conversion modes (supports profiles 8.1, 8.4, MEL, and more).",
        style: {borderColor: "purple"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 4,
        icon: "faFilm",

        inputs: [
            {
                label: "Dovi Tool Path",
                name: "doviToolPath",
                tooltip: "Required: full path to dovi_tool. Install DV Tools sets this as doviToolBin in its plugin output.",
                inputType: "string",
                defaultValue: "{{{args.variables.doviToolBin}}}",
                inputUI: {type: "directory"},
            },
            {
                label: "Conversion Mode",
                name: "conversionMode",
                tooltip: "dovi_tool conversion mode (-m flag). Mode 0: Parse & rewrite untouched. Mode 1: Convert to MEL compatible. Mode 2: Convert to profile 8.1 (removes luma/chroma mapping for P7 FEL). Mode 3: Convert profile 5 to 8.1. Mode 4: Convert to profile 8.4. Mode 5: Convert to profile 8.1 preserving mapping (legacy mode 2).",
                inputType: "string",
                defaultValue: "2",
                inputUI: {type: "text"},
            },
            {
                label: "BL HEVC Path",
                name: "blHevcPath",
                tooltip: "Path to the HEVC stream to convert. Leave empty to use Tdarr cache directory + <basename>.hevc.",
                inputType: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            },
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory to place temporary conversion output. Leave empty to use Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            }
        ],

        outputs: [{number: 1, tooltip: "Continue to next step"}],
    });
    exports.details = details;

    const plugin = async (args) => {
        const lib = require("../../../../../methods/Pleaselib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "== Starting HEVC → DV Conversion ==");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.librarySettings.cache;

        const baseName = path.basename(inputPath, path.extname(inputPath));

        const doviToolPath = (resolveInput(args.inputs.doviToolPath, args) || "").toString().trim();
        if (!doviToolPath) {
            log(jobLog, "🚫 Missing dovi_tool path (input: Dovi Tool Path). Set it, e.g. from Install DV Tools (doviToolBin).");
            throw new Error("Missing dovi_tool path");
        }

        const userBlHevcPath = (resolveInput(args.inputs.blHevcPath, args) || "").toString().trim();
        const blHevcPath =
            userBlHevcPath.length > 0
                ? userBlHevcPath
                : (args.variables.blHevcPath || "").toString().trim() || path.join(args.librarySettings.cache, `${baseName}.hevc`);

        const blHevcOutputPath = blHevcPath; // final output should replace the original path
        const tempBlHevcOutputPath = path.join(workDir, `${baseName}_BL_DV_temp.hevc`);

        log(jobLog, `Working dir (temp): ${workDir}`);
        log(jobLog, `Base filename: ${baseName}`);
        log(jobLog, `HEVC (input/output): ${blHevcPath}`);
        log(jobLog, `Temp HEVC→DV Output: ${tempBlHevcOutputPath}`);

        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating temp directory: ${workDir}`);
                fs.mkdirSync(workDir, {recursive: true});
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure temp directory exists: ${workDir}`);
            console.error(err);
        }

        if (fs.existsSync(tempBlHevcOutputPath)) {
            log(jobLog, `🧹 Removing existing temp file: ${tempBlHevcOutputPath}`);
            try {
                fs.unlinkSync(tempBlHevcOutputPath);
            } catch (err) {
                log(jobLog, `⚠️ Unable to remove temp file, continuing: ${err.message}`);
            }
        }

        const conversionMode = (resolveInput(args.inputs.conversionMode, args) || "2").toString().trim();
        log(jobLog, `🛠 Converting HEVC using dovi_tool mode ${conversionMode}...`);
        try {
            await runSpawn(doviToolPath, [
                "-m", conversionMode,
                "convert",
                "-i", blHevcPath,
                "-o", tempBlHevcOutputPath,
            ]);

            try {
                fs.renameSync(tempBlHevcOutputPath, blHevcOutputPath);
            } catch (renameErr) {
                log(jobLog, `⚠️ Rename failed (${renameErr.message}), attempting copy to final path`);
                fs.copyFileSync(tempBlHevcOutputPath, blHevcOutputPath);
                fs.unlinkSync(tempBlHevcOutputPath);
            }

            log(jobLog, "✔ HEVC→DV Conversion Done (output replaced original path)");
        } catch (e) {
            console.error("🚨 HEVC conversion failed:", e.message);
            throw e;
        }

        return {
            outputFileObj: inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();
