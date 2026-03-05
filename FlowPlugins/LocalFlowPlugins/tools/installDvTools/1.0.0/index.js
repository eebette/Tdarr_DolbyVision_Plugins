"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    /**
     * DV Tools Install Plugin
     * Installs:
     * - GPAC / MP4Box (via .deb extraction, no root)
     * - dovi_tool
     * - dotnet runtime
     * - PgsToSrt
     * - Tesseract tessdata
     */

    const fs = require("fs");
    const path = require("path");
    const https = require("https");
    const {execSync} = require("child_process");

    process.env.DOTNET_CLI_TELEMETRY_OPTOUT = "1";

    const HOME = process.env.HOME || "/home/tdarr";

    // -------------------------
    // Logging
    // -------------------------
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

    // -------------------------
    // Utility helpers
    // -------------------------
    function ensureDir(dir, jobLog) {
        if (!fs.existsSync(dir)) {
            log(jobLog, `📁 Creating: ${dir}`);
            fs.mkdirSync(dir, {recursive: true});
        }
    }

    function downloadFile(url, dest, jobLog) {
        return new Promise((resolve, reject) => {
            log(jobLog, `⬇️ Downloading: ${url}`);

            const file = fs.createWriteStream(dest);

            https
                .get(url, (res) => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
                        return;
                    }
                    res.pipe(file);
                    file.on("finish", () => file.close(resolve));
                })
                .on("error", reject);
        });
    }

    function downloadAndExtract(url, destDir, tarArgs, jobLog) {
        log(jobLog, `⬇️ Fetching: ${url}`);
        ensureDir(destDir, jobLog);
        execSync(`wget -qO- "${url}" | tar ${tarArgs} -C "${destDir}"`, {
            stdio: "inherit",
            env: process.env,
        });
    }

    // Fetch latest GPAC .deb URL from the official dist.gpac.io APT repository
    function fetchLatestGpacDebUrl(jobLog) {
        const packagesUrl = "https://dist.gpac.io/gpac/linux/ubuntu/dists/noble/nightly/binary-amd64/Packages";
        const repoBase = "https://dist.gpac.io/gpac/linux/ubuntu/";

        return new Promise((resolve, reject) => {
            log(jobLog, "🔎 Checking for latest GPAC/MP4Box build...");
            https
                .get(
                    packagesUrl,
                    {headers: {"User-Agent": "Tdarr-DV-Installer"}},
                    (res) => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`Failed to fetch GPAC package listing: HTTP ${res.statusCode}`));
                            return;
                        }

                        const chunks = [];
                        res.on("data", (chunk) => chunks.push(chunk));
                        res.on("end", () => {
                            const body = Buffer.concat(chunks).toString();
                            // Find all Filename entries for the gpac package (not libgpac-dev)
                            // Packages file format: blocks separated by blank lines
                            const blocks = body.split(/\n\n+/);
                            let latestFilename = "";
                            for (const block of blocks) {
                                const pkgMatch = block.match(/^Package:\s*(.+)$/m);
                                const fileMatch = block.match(/^Filename:\s*(.+)$/m);
                                if (pkgMatch && pkgMatch[1].trim() === "gpac" && fileMatch) {
                                    latestFilename = fileMatch[1].trim();
                                }
                            }
                            if (!latestFilename) {
                                reject(new Error("No GPAC .deb found in APT repository listing"));
                                return;
                            }
                            const url = repoBase + latestFilename;
                            log(jobLog, `🆕 Latest GPAC build detected: ${url}`);
                            resolve(url);
                        });
                    }
                )
                .on("error", reject);
        });
    }

    // -------------------------
    // Install MP4Box via .deb extraction (NO copying)
    // -------------------------
    async function installMP4BoxFromDeb(jobLog, OPT) {
        const gpacDir = path.join(OPT, "gpac");

        // FINAL desired MP4Box path — do NOT copy out of gpacDir
        const mp4boxBin = path.join(gpacDir, "usr/bin/MP4Box");
        const libDir = path.join(gpacDir, "usr/lib");

        if (fs.existsSync(mp4boxBin)) {
            log(jobLog, `➡️ MP4Box already installed`);
            return {mp4boxBin, libDir};
        }

        ensureDir(gpacDir, jobLog);

        const debUrl = await fetchLatestGpacDebUrl(jobLog);

        const debFile = path.join(gpacDir, "gpac.deb");

        log(jobLog, "⬇️ Downloading GPAC/MP4Box .deb...");
        await downloadFile(debUrl, debFile, jobLog);

        log(jobLog, "📦 Extracting GPAC .deb...");
        execSync(`dpkg-deb -x gpac.deb .`, {
            cwd: gpacDir,
            stdio: "inherit",
            env: process.env,
        });

        // Ensure MP4Box is executable
        fs.chmodSync(mp4boxBin, 0o755);

        log(jobLog, `✔ MP4Box installed at: ${mp4boxBin}`);
        log(jobLog, `✔ GPAC libraries located at: ${libDir}`);

        return {mp4boxBin, libDir};
    }

    // -------------------------
    // Install mkvtoolnix via .deb extraction (NO copying)
    // -------------------------
    async function installMkvtoolnix(jobLog, OPT) {
        const mkvDir = path.join(OPT, "mkvtoolnix");

        // FINAL desired binary paths — do NOT copy out of mkvDir
        const mkvextractBin = path.join(mkvDir, "usr/bin/mkvextract");
        const mkvmergeBin = path.join(mkvDir, "usr/bin/mkvmerge");

        if (fs.existsSync(mkvextractBin) && fs.existsSync(mkvmergeBin)) {
            log(jobLog, `➡️ mkvtoolnix already installed`);
            return {mkvextractBin, mkvmergeBin};
        }

        ensureDir(mkvDir, jobLog);

        const debUrl = "https://mkvtoolnix.download/ubuntu/pool/noble/main/m/mkvtoolnix/mkvtoolnix_96.0-0~ubuntu2404bunkus01_amd64.deb";
        const debFile = path.join(mkvDir, "mkvtoolnix.deb");

        log(jobLog, "⬇️ Downloading mkvtoolnix .deb...");
        await downloadFile(debUrl, debFile, jobLog);

        log(jobLog, "📦 Extracting mkvtoolnix .deb...");
        execSync(`dpkg-deb -x mkvtoolnix.deb .`, {
            cwd: mkvDir,
            stdio: "inherit",
            env: process.env,
        });

        // Ensure binaries are executable
        fs.chmodSync(mkvextractBin, 0o755);
        fs.chmodSync(mkvmergeBin, 0o755);

        log(jobLog, `✔ mkvextract installed at: ${mkvextractBin}`);
        log(jobLog, `✔ mkvmerge installed at: ${mkvmergeBin}`);

        return {mkvextractBin, mkvmergeBin};
    }

    // -------------------------
    // Install libjpeg dependency for MP4Box (non-root, local to gpac)
    // -------------------------
    async function installLibjpeg(jobLog, OPT) {
        const gpacDir = path.join(OPT, "gpac");
        const libTargetDir = path.join(gpacDir, "usr/lib");
        const libMain = path.join(libTargetDir, "libjpeg.so.62.3.0");
        const libLink = path.join(libTargetDir, "libjpeg.so.62");

        if (fs.existsSync(libMain) || fs.existsSync(libLink)) {
            log(jobLog, "➡️ libjpeg.so.62 already present for MP4Box");
            return;
        }

        ensureDir(libTargetDir, jobLog);

        const debUrl = "https://ftp.debian.org/debian/pool/main/libj/libjpeg-turbo/libjpeg62-turbo_2.1.5-4_amd64.deb";
        const debFile = path.join(gpacDir, "libjpeg62-turbo.deb");
        const extractDir = path.join(gpacDir, "libjpeg62-turbo");

        log(jobLog, "⬇️ Downloading libjpeg62-turbo (MP4Box dependency)...");
        await downloadFile(debUrl, debFile, jobLog);

        // Clean previous extraction if present
        try { fs.rmSync(extractDir, {recursive: true, force: true}); } catch (_) {}

        log(jobLog, "📦 Extracting libjpeg62-turbo .deb...");
        execSync(`dpkg-deb -x "${debFile}" "${extractDir}"`, {
            stdio: "inherit",
            env: process.env,
        });

        const srcDir = path.join(extractDir, "usr/lib/x86_64-linux-gnu");
        if (!fs.existsSync(srcDir)) {
            throw new Error("libjpeg62-turbo deb extraction missing expected usr/lib/x86_64-linux-gnu directory");
        }

        // Copy both the real file and symlink; -a preserves symlink
        execSync(`cp -a "${srcDir}/libjpeg.so.62"* "${libTargetDir}/"`, {
            stdio: "inherit",
            env: process.env,
        });

        // Cleanup temp extraction
        try { fs.rmSync(extractDir, {recursive: true, force: true}); } catch (_) {}

        log(jobLog, `✔ Installed libjpeg.so.62 into ${libTargetDir}`);
    }

    // -------------------------
    // Plugin Details
    // -------------------------
    const details = () => ({
        name: "Install DV Tools",
        description:
            "Installs DV processing dependencies (MP4Box, mkvtoolnix, dovi_tool, dotnet, PgsToSrt, tessdata). Idempotent.",
        style: {borderColor: "purple"},
        tags: "utility",
        isStartPlugin: true,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 1,
        icon: "faWrench",
        inputs: [
            {
                label: "Install Directory",
                name: "installDirectory",
                tooltip: "Optional: directory to install DV tools (MP4Box, dovi_tool, dotnet, PgsToSrt, tessdata). Leave empty to use default.",
                type: "string",
                defaultValue: "",
                inputUI: {type: "directory"},
            }
        ],
        outputs: [{number: 1, tooltip: "Continue after tools installation"}],
    });
    exports.details = details;

    // -------------------------
    // Plugin Entrypoint
    // -------------------------
    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "=== DV Tools Install Plugin Start ===");

        const configuredInstallDir = (resolveInput(args.inputs.installDirectory, args) || "").toString().trim() || "";
        const optRoot = configuredInstallDir.length > 0 ? configuredInstallDir : path.join(HOME, "opt");
        const OPT = optRoot;

        // ---------------------------------------
        // Install MP4Box
        // ---------------------------------------
        const {mp4boxBin, libDir: mp4boxLibDir} =
            await installMP4BoxFromDeb(jobLog, OPT);
        await installLibjpeg(jobLog, OPT);

        // ---------------------------------------
        // Install mkvtoolnix
        // ---------------------------------------
        const {mkvextractBin, mkvmergeBin} =
            await installMkvtoolnix(jobLog, OPT);

        // ---------------------------------------
        // dovi_tool
        // ---------------------------------------
        const doviDir = path.join(OPT, "dovi_tool");
        const doviToolBin = path.join(doviDir, "dovi_tool");

        if (!fs.existsSync(doviToolBin)) {
            downloadAndExtract(
                "https://github.com/quietvoid/dovi_tool/releases/download/2.3.1/dovi_tool-2.3.1-x86_64-unknown-linux-musl.tar.gz",
                doviDir,
                "-xz --strip-components=1",
                jobLog
            );
            log(jobLog, "✔ Installed dovi_tool");
        } else {
            log(jobLog, "➡️ dovi_tool already installed");
        }

        // ---------------------------------------
        // dotnet runtime
        // ---------------------------------------
        const dotnetDir = path.join(OPT, "dotnet");
        const dotnetBin = path.join(dotnetDir, "dotnet");

        if (!fs.existsSync(dotnetBin)) {
            ensureDir(dotnetDir, jobLog);
            log(jobLog, "⬇️ Installing dotnet runtime...");
            execSync(
                `wget -qO- "https://builds.dotnet.microsoft.com/dotnet/Sdk/6.0.428/dotnet-sdk-6.0.428-linux-x64.tar.gz" | tar -xz -C "${dotnetDir}"`,
                {stdio: "inherit", env: process.env}
            );
            log(jobLog, "✔ Installed dotnet");
        } else {
            log(jobLog, "➡️ dotnet already installed");
        }

        // ---------------------------------------
        // PgsToSrt
        // ---------------------------------------
        const pgsDir = path.join(OPT, "PgsToSrt");
        const pgsToSrtDll = path.join(pgsDir, "PgsToSrt.dll");

        if (!fs.existsSync(pgsToSrtDll)) {
            ensureDir(pgsDir, jobLog);
            log(jobLog, "⬇️ Installing PgsToSrt...");
            execSync(
                `wget -qO /tmp/temp.zip "https://github.com/Tentacule/PgsToSrt/releases/download/v1.4.7/PgsToStr-1.4.7.zip"`,
                {stdio: "inherit", env: process.env}
            );
            execSync(`unzip -o /tmp/temp.zip -d "${pgsDir}"`, {
                stdio: "inherit",
                env: process.env,
            });
            execSync(`rm /tmp/temp.zip`, {stdio: "inherit", env: process.env});
            log(jobLog, "✔ Installed PgsToSrt");
        } else {
            log(jobLog, "➡️ PgsToSrt already installed");
        }

        // ---------------------------------------
        // Tesseract tessdata
        // ---------------------------------------
        const tessDir = path.join(pgsDir, "tessdata");
        if (!fs.existsSync(path.join(tessDir, "eng.traineddata"))) {
            log(jobLog, "⬇️ Installing Tesseract tessdata...");
            downloadAndExtract(
                "https://github.com/tesseract-ocr/tessdata/archive/refs/tags/4.1.0.tar.gz",
                tessDir,
                "-xz --strip-components=1",
                jobLog
            );
            log(jobLog, "✔ Installed tessdata");
        } else {
            log(jobLog, "➡️ tessdata already present");
        }

        log(jobLog, "🎯 DV Tools Install Complete");
        log(jobLog, "=== DV Tools Install Plugin End ===");

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: {
                ...args.variables,
                dvToolsInstalled: true,

                // === OUTPUT BINARY PATHS ===
                mp4boxBin,
                mp4boxLibDir,
                mkvextractBin,
                mkvmergeBin,
                doviToolBin,
                dotnetBin,
                pgsToSrtDll,

                dotnetTelemetryOptOut: true,
            },
        };
    };
    exports.plugin = plugin;

})();   // END OF CLOSURE
