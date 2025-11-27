"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    // ----------------------------------------
    // Requires
    // ----------------------------------------
    const fs = require("fs");
    const path = require("path");
    const {spawn} = require("child_process");

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

    // ----------------------------------------
    // Async spawn wrapper (unchanged)
    // ----------------------------------------
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

    // ----------------------------------------
    // Plugin Details
    // ----------------------------------------
    const details = () => ({
        name: "Extract RPU from HEVC",
        description: "Extracts Dolby Vision RPU from an HEVC track.",
        style: {borderColor: "purple"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 4,
        icon: "faBolt",

        inputs: [
            {
                label: "Dovi Tool Path",
                name: "doviToolPath",
                tooltip:
                    "Required: full path to dovi_tool. Install DV Tools sets this as doviToolBin in its plugin output.",
                type: "string",
                defaultValue: "{{{args.variables.doviToolBin}}}",
                inputUI: {type: "directory"},
            },
            {
                label: "BL HEVC Path",
                name: "blHevcPath",
                tooltip:
                    "Optional: path to HEVC track. Leave empty to fall back to Tdarr cache directory + <basename>.hevc (output of Extract HEVC).",
                type: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            },
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip:
                    "Optional: directory to store the generated RPU.bin. Leave empty to use the Tdarr cache directory.",
                type: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            }
        ],

        outputs: [{number: 1, tooltip: "Continue to next step"}],
    });
    exports.details = details;

    // ----------------------------------------
    // Plugin Entrypoint
    // ----------------------------------------
    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "== Starting Generate RPU file ==");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;

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

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";

        // Determine output directory:
        // 1. Use user input if non-empty
        // 2. Otherwise use Step 1 workDir variable
        const outputDir =
            configuredOutputDir.length > 0
                ? configuredOutputDir
                : args.librarySettings.cache;

        log(jobLog, `Base filename: ${baseName}`);
        log(jobLog, `Working directory for RPU: ${outputDir}`);
        log(jobLog, `dovi_tool path: ${doviToolPath}`);
        log(jobLog, `BL7 HEVC: ${blHevcPath}`);

        // Ensure output directory exists
        try {
            if (!fs.existsSync(outputDir)) {
                log(jobLog, `📁 Creating directory: ${outputDir}`);
                fs.mkdirSync(outputDir, {recursive: true});
            } else {
                log(jobLog, `📂 Directory already exists: ${outputDir}`);
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${outputDir}`);
            console.error(err);
        }

        // Output file path
        const rpuPath = path.join(outputDir, `${baseName}_RPU.bin`);
        log(jobLog, `RPU output path: ${rpuPath}`);

        if (fs.existsSync(rpuPath)) {
            log(jobLog, "✔ RPU already exists - skipping extraction");
        } else {
            log(jobLog, "🛠 Running Dolby Vision RPU extraction...");

            try {
                await runSpawn(doviToolPath, [
                    "extract-rpu",
                    "-i", blHevcPath,
                    "-o", rpuPath,
                ]);

                log(jobLog, "✔ RPU extraction complete");
            } catch (e) {
                log(jobLog, `🚨 RPU extraction failed: ${e.message}`);

                return {
                    outputFileObj: inputFileObj,
                    outputNumber: 1,
                    variables: args.variables,
                    error: e.message,
                };
            }
        }

        return {
            outputFileObj: inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };

    exports.plugin = plugin;

})();  // END WRAPPER
