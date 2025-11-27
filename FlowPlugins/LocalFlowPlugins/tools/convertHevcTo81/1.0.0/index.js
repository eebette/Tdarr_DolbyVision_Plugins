"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    // HEVC → DV8.1 Converter (Async spawn version)
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
        name: "Convert HEVC to DV8.1",
        description: "Convert an HEVC bitstream to Dolby Vision Profile 8.1 via dovi_tool.",
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
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "== Starting Convert HEVC → DV8.1 ==");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.librarySettings.cache;

        const baseName = path.basename(inputPath, path.extname(inputPath));

        const doviToolPath = (resolveInput(args.inputs.doviToolPath, args) || "").toString().trim();
        if (!doviToolPath) {
            log(jobLog, "🚫 Missing dovi_tool path (input: Dovi Tool Path). Set it, e.g. from Install DV Tools (doviToolBin).");
            return {
                outputFileObj: inputFileObj,
                outputNumber: 1,
                variables: args.variables,
                error: "Missing dovi_tool path",
            };
        }

        const userBlHevcPath = (resolveInput(args.inputs.blHevcPath, args) || "").toString().trim();
        const blHevcPath =
            userBlHevcPath.length > 0
                ? userBlHevcPath
                : (args.variables.blHevcPath || "").toString().trim() || path.join(args.librarySettings.cache, `${baseName}.hevc`);

        const blHevc81Path = blHevcPath; // final output should replace the original path
        const tempBlHevc81Path = path.join(workDir, `${baseName}_BL81_temp.hevc`);

        log(jobLog, `Working dir (temp): ${workDir}`);
        log(jobLog, `Base filename: ${baseName}`);
        log(jobLog, `HEVC (input/output): ${blHevcPath}`);
        log(jobLog, `Temp HEVC→DV8.1 Output: ${tempBlHevc81Path}`);

        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating temp directory: ${workDir}`);
                fs.mkdirSync(workDir, {recursive: true});
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure temp directory exists: ${workDir}`);
            console.error(err);
        }

        if (fs.existsSync(tempBlHevc81Path)) {
            log(jobLog, `🧹 Removing existing temp file: ${tempBlHevc81Path}`);
            try {
                fs.unlinkSync(tempBlHevc81Path);
            } catch (err) {
                log(jobLog, `⚠️ Unable to remove temp file, continuing: ${err.message}`);
            }
        }

        log(jobLog, "🛠 Converting HEVC to DV Profile 8.1...");
        try {
            await runSpawn(doviToolPath, [
                "-m", "2", // profile 8.1 conversion mode
                "convert",
                "-i", blHevcPath,
                "-o", tempBlHevc81Path,
            ]);

            try {
                fs.renameSync(tempBlHevc81Path, blHevc81Path);
            } catch (renameErr) {
                log(jobLog, `⚠️ Rename failed (${renameErr.message}), attempting copy to final path`);
                fs.copyFileSync(tempBlHevc81Path, blHevc81Path);
                fs.unlinkSync(tempBlHevc81Path);
            }

            log(jobLog, "✔ HEVC→DV8.1 Conversion Done (output replaced original path)");
        } catch (e) {
            console.error("🚨 HEVC conversion failed:", e.message);
            return {
                outputFileObj: inputFileObj,
                outputNumber: 1,
                variables: args.variables,
                error: e.message
            };
        }

        return {
            outputFileObj: inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();
