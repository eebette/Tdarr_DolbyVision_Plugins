"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

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
        name: "Inject RPU into HEVC (DV8.1)",
        description: "Injects an extracted RPU into an HEVC bitstream via dovi_tool inject-rpu.",
        style: {borderColor: "purple"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 5,
        icon: "faBolt",

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
                label: "HEVC Path",
                name: "hevcPath",
                tooltip: "Path to HEVC bitstream to inject into (e.g., output from Convert HEVC to DV8.1). Leave empty to use Tdarr cache <basename>.hevc.",
                inputType: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            },
            {
                label: "RPU Path",
                name: "rpuPath",
                tooltip: "Path to RPU.bin (e.g., from Extract RPU). Leave empty to use Tdarr cache <basename>_RPU.bin.",
                inputType: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            },
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory for the injected HEVC. Leave empty to use Tdarr cache.",
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
        log(jobLog, "=== Inject RPU into HEVC (DV8.1) Start ===");

        const inputFileObj = args.inputFileObj;
        const inputPath = inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.librarySettings.cache;

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

        const userHevcPath = (resolveInput(args.inputs.hevcPath, args) || "").toString().trim();
        const hevcPath =
            userHevcPath.length > 0
                ? userHevcPath
                : (args.variables.blHevcPath || "").toString().trim() || path.join(args.librarySettings.cache, `${baseName}.hevc`);

        const userRpuPath = (resolveInput(args.inputs.rpuPath, args) || "").toString().trim();
        const rpuPath =
            userRpuPath.length > 0
                ? userRpuPath
                : path.join(args.librarySettings.cache, `${baseName}_RPU.bin`);

        if (!fs.existsSync(hevcPath)) {
            log(jobLog, `🚫 HEVC not found: ${hevcPath}`);
            return {
                outputFileObj: inputFileObj,
                outputNumber: 1,
                variables: args.variables,
                error: "HEVC input missing",
            };
        }

        if (!fs.existsSync(rpuPath)) {
            log(jobLog, `🚫 RPU not found: ${rpuPath}`);
            return {
                outputFileObj: inputFileObj,
                outputNumber: 1,
                variables: args.variables,
                error: "RPU input missing",
            };
        }

        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating directory: ${workDir}`);
                fs.mkdirSync(workDir, {recursive: true});
            } else {
                log(jobLog, `📂 Directory exists: ${workDir}`);
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${workDir}`);
            console.error(err);
        }

        const outputHevc = path.join(workDir, `${baseName}_DV81.hevc`);
        log(jobLog, `HEVC input: ${hevcPath}`);
        log(jobLog, `RPU input: ${rpuPath}`);
        log(jobLog, `Output HEVC: ${outputHevc}`);

        if (fs.existsSync(outputHevc)) {
            log(jobLog, "✔ Output already exists - skipping inject");
        } else {
            log(jobLog, "🛠 Injecting RPU into HEVC...");
            try {
                await runSpawn(doviToolPath, [
                    "inject-rpu",
                    "-i", hevcPath,
                    "-r", rpuPath,
                    "-o", outputHevc,
                ]);
                log(jobLog, "✔ RPU injection complete");
            } catch (e) {
                log(jobLog, `🚨 RPU injection failed: ${e.message}`);
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
            variables: args.variables,
        };
    };

    exports.plugin = plugin;

})(); // end closure
