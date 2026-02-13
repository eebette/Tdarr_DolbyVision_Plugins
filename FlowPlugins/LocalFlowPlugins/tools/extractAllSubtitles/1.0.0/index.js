"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    const fs = require("fs");
    const path = require("path");
    const { execSync, execFileSync } = require("child_process");

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

        return "";
    }

    function guessSubtitleExt(codec) {
        const c = (codec || "").toLowerCase();
        if (c.includes("pgs") || c.includes("hdmv")) return "sup";
        if (c === "ass") return "ass";
        if (c === "ssa") return "ssa";
        if (c === "webvtt" || c === "vtt") return "vtt";
        if (c === "subrip" || c === "srt") return "srt";
        if (c === "mov_text" || c === "text") return "srt";
        return "sub";
    }

    // Fix malformed SRT timestamps from PgsToSrt (e.g., "-00:00:00,001 --> 00:00:01,000")
    function sanitizeSrtFile(filePath, jobLog) {
        try {
            let content = fs.readFileSync(filePath, "utf8");
            const original = content;

            // Match timestamp lines with optional leading dash and normalize arrow to -->
            content = content.replace(
                /^-?\s*(\d{2}:\d{2}:\d{2},\d{3})\s*-+>\s*(\d{2}:\d{2}:\d{2},\d{3})\s*$/gm,
                "$1 --> $2"
            );

            // Ensure blank line between entries: if a sequence number follows a timestamp
            // line without a blank line, insert one
            content = content.replace(
                /(\d{2}:\d{2}:\d{2},\d{3})\r?\n(\d+\r?\n\d{2}:\d{2}:\d{2})/g,
                "$1\n\n$2"
            );

            if (content !== original) {
                fs.writeFileSync(filePath, content, "utf8");
                log(jobLog, `🔧 Fixed malformed SRT timestamps in: ${path.basename(filePath)}`);
            }
        } catch (err) {
            log(jobLog, `⚠ Failed to sanitize SRT file: ${err.message}`);
        }
    }

    // MKVINFO parser to get subtitle track numbers (for PGS conversions)
    function getSubtitleTrackNumbers(inputPath) {
        try {
            const raw = execSync(`mkvinfo "${inputPath}"`, {
                maxBuffer: 1024 * 1024 * 200
            }).toString();

            const lines = raw.split(/\r?\n/);
            const tracks = [];
            let current = null;

            for (let lineRaw of lines) {
                const line = lineRaw.trim();

                if (line === "| + Track" || line === "+ Track") {
                    if (current && current.track_type && current.track_number) {
                        tracks.push(current);
                    }
                    current = {};
                    continue;
                }

                if (!current) continue;

                let m = line.match(/Track number:\s*([0-9]+)/);
                if (m) {
                    current.track_number = parseInt(m[1], 10);
                    continue;
                }

                m = line.match(/Track type:\s*(\w+)/);
                if (m) {
                    current.track_type = m[1];
                    continue;
                }
            }

            if (current && current.track_type && current.track_number) {
                tracks.push(current);
            }

            return tracks
                .filter((t) => t.track_type === "subtitles")
                .map((t) => t.track_number);
        } catch (err) {
            console.warn("mkvinfo failed, skipping MKV track mapping:", err.message);
            return [];
        }
    }

    const details = () => ({
        name: "Extract All Subtitles to SRT",
        description: "Extracts all subtitle streams to SRT (text copied, PGS OCR via PgsToSrt).",
        style: { borderColor: "purple" },
        tags: "subtitles",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 7,
        icon: "faClosedCaptioning",

        inputs: [
            {
                label: "Dotnet Path",
                name: "dotnetPath",
                tooltip: "Full path to dotnet binary used to run PgsToSrt.",
                inputType: "string",
                defaultValue: "{{{args.variables.dotnetBin}}}",
                inputUI: { type: "directory" },
            },
            {
                label: "PgsToSrt Path",
                name: "pgsToSrtPath",
                tooltip: "Full path to PgsToSrt DLL/binary.",
                inputType: "string",
                defaultValue: "{{{args.variables.pgsToSrtDll}}}",
                inputUI: { type: "directory" },
            },
            {
                label: "Output Directory",
                name: "outputDirectory",
                tooltip: "Optional: directory to place exported subtitles. Leave empty to use the Tdarr cache directory.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "directory" },
            },
            {
                label: "Keep Original Subtitle Streams",
                name: "keepOriginalSubtitles",
                tooltip: "If true, keep original subtitle streams (PGS/ASS/etc.) alongside extracted SRTs.",
                inputType: "boolean",
                defaultValue: "false",
                inputUI: { type: "switch" },
            },
            {
                label: "Preserve Stream Metadata",
                name: "preserveMetadata",
                tooltip: "If true, preserve stream metadata (title, SDH/hearing_impaired, default, forced, etc.) in the manifest and embed in converted subtitles where possible.",
                inputType: "boolean",
                defaultValue: "true",
                inputUI: { type: "switch" },
            },
            {
                label: "Prefer Text Subtitle as Default",
                name: "preferTextDefault",
                tooltip: "When enabled, if the default subtitle is image-based (PGS), transfer the default flag to the first non-image-based, non-commentary text subtitle of the same language. If no suitable text subtitle exists, the default remains unchanged.",
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
        log(jobLog, "=== Extract All Subtitles Plugin Start ===");

        const ffprobe = args.inputFileObj.ffProbeData;
        const inputPath = args.inputFileObj.file;
        const baseName = path.basename(inputPath, path.extname(inputPath));

        const configuredOutputDir = (resolveInput(args.inputs.outputDirectory, args) || "").toString().trim() || "";
        const workDir = configuredOutputDir.length > 0 ? configuredOutputDir : args.workDir;
        const keepOriginal = String(resolveInput(args.inputs.keepOriginalSubtitles, args)) === "true";
        const preserveMetadata = String(resolveInput(args.inputs.preserveMetadata, args)) !== "false";
        const preferTextDefault = String(resolveInput(args.inputs.preferTextDefault, args)) === "true";

        try {
            if (!fs.existsSync(workDir)) {
                log(jobLog, `📁 Creating directory: ${workDir}`);
                fs.mkdirSync(workDir, { recursive: true });
            } else {
                log(jobLog, `📂 Directory exists: ${workDir}`);
            }
        } catch (err) {
            log(jobLog, `🚨 Failed to ensure directory exists: ${workDir}`);
            console.error(err);
        }

        const subtitleStreams = ffprobe.streams.filter((s) => s.codec_type === "subtitle");
        if (subtitleStreams.length === 0) {
            log(jobLog, "⚠ No subtitle streams → skip");
            return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
        }

        // Map MKV track numbers for PGS conversion when available
        const mkvTrackNumbers = getSubtitleTrackNumbers(inputPath);
        for (let i = 0; i < subtitleStreams.length; i++) {
            subtitleStreams[i].mkvTrack = mkvTrackNumbers[i];
        }

        const exportsFile = path.join(workDir, `${baseName}_subtitles.exports`);
        fs.writeFileSync(exportsFile, ""); // clear or create
        const manifestEntries = [];

        const dotnetPath = (resolveInput(args.inputs.dotnetPath, args) || "").toString().trim();
        const pgsToSrtPath = (resolveInput(args.inputs.pgsToSrtPath, args) || "").toString().trim();

        const preferredTextCodecs = ["subrip", "ass", "ssa", "srt", "text", "mov_text", "webvtt"];
        const tessLangMap = {
            eng: "eng", en: "eng",
            jpn: "jpn", ja: "jpn",
            fre: "fra", fr: "fra",
            spa: "spa", es: "spa",
            ger: "deu", de: "deu",
            ita: "ita", it: "ita",
            por: "por", pt: "por",
            chi: "chi_sim", zho: "chi_sim",
            kor: "kor", ko: "kor",
            und: "eng"
        };

        for (let i = 0; i < subtitleStreams.length; i++) {
            const s = subtitleStreams[i];
            const codec = (s.codec_name || "").toLowerCase();
            const lang = (s.tags?.language || "und").toLowerCase();
            const title = s.tags?.title || "";
            const forced = s.disposition?.forced ? 1 : 0;
            const hearingImpaired = s.disposition?.hearing_impaired ? 1 : 0;
            const visualImpaired = s.disposition?.visual_impaired ? 1 : 0;
            const isDefault = s.disposition?.default ? 1 : 0;
            const isComment = s.disposition?.comment ? 1 : 0;
            const ffmpegIdx = s.index;
            const mkvTrackNumber = s.mkvTrack;

            const safeLang = lang || "und";
            const outFile = `${baseName}_s${ffmpegIdx}_${safeLang}.srt`;
            const outPath = path.join(workDir, outFile);
            const manifestIndex = mkvTrackNumber || ffmpegIdx;

            // Optionally preserve the original subtitle stream as-is
            if (keepOriginal) {
                const origExt = guessSubtitleExt(codec);
                const origFile = `${baseName}_s${ffmpegIdx}_${safeLang}_orig.${origExt}`;
                const origPath = path.join(workDir, origFile);
                try {
                    const copyCmd = [
                        `ffmpeg -y -i "${inputPath}"`,
                        `-map 0:${ffmpegIdx}`,
                        `-c:s copy`,
                        `"${origPath}"`
                    ].join(" ");
                    log(jobLog, `📥 Keeping original subtitle: idx=${ffmpegIdx}, lang=${lang}, codec=${codec}, out=${origFile}`);
                    log(jobLog, `📋 Command: ${copyCmd}`);
                    execSync(copyCmd, { stdio: "inherit" });
                    manifestEntries.push({
                        file: origFile, index: manifestIndex, lang, codec, forced,
                        title, hearingImpaired, visualImpaired, isDefault, isComment,
                        isImageBased: codec.includes("pgs") || codec.includes("hdmv")
                    });
                } catch (err) {
                    log(jobLog, `⚠ Failed to keep original subtitle idx=${ffmpegIdx}: ${err.message}`);
                    log(jobLog, `⏭ Skipping to next subtitle...`);
                    continue;
                }
            }

            try {
                if (preferredTextCodecs.includes(codec)) {
                    log(jobLog, `✔ Converting text subtitle to SRT: idx=${ffmpegIdx}, lang=${lang}, codec=${codec}`);
                    const metadataFlags = [];
                    if (preserveMetadata) {
                        if (title) metadataFlags.push(`-metadata:s:0 title="${title.replace(/"/g, '\\"')}"`);
                        if (lang && lang !== "und") metadataFlags.push(`-metadata:s:0 language=${lang}`);
                    }
                    const cmd = [
                        `ffmpeg -y -i "${inputPath}"`,
                        `-map 0:${ffmpegIdx}`,
                        `-c:s srt`,
                        ...metadataFlags,
                        `"${outPath}"`
                    ].join(" ");
                    log(jobLog, `📋 Command: ${cmd}`);
                    execSync(cmd, { stdio: "inherit" });
                } else if (codec.includes("pgs") || codec.includes("hdmv")) {
                    log(jobLog, `🖼 OCR PGS subtitle: idx=${ffmpegIdx}, lang=${lang}, mkvTrack=${mkvTrackNumber || "n/a"}`);
                    if (!dotnetPath || !pgsToSrtPath) {
                        throw new Error("dotnetPath or pgsToSrtPath not provided for PGS OCR");
                    }

                    const tessLang = tessLangMap[safeLang] || "eng";
                    const attempted = new Set(); // avoid duplicate invocations
                    const attemptOrder = [];
                    const primaryTrack = mkvTrackNumber ?? (typeof ffmpegIdx === "number" ? ffmpegIdx + 1 : undefined);
                    if (primaryTrack !== undefined) attemptOrder.push({ label: `track ${primaryTrack}`, flag: [`--track=${primaryTrack}`] });
                    if (mkvTrackNumber && mkvTrackNumber > 0) {
                        const zeroBased = mkvTrackNumber - 1;
                        attemptOrder.push({ label: `track ${zeroBased} (zero-based fallback)`, flag: [`--track=${zeroBased}`] });
                    }

                    let ocrSuccess = false;
                    let lastErr = null;

                    for (const attempt of attemptOrder) {
                        const attemptKey = attempt.flag.join(":");
                        if (attempted.has(attemptKey)) continue;
                        attempted.add(attemptKey);
                        try {
                            const argsList = [
                                pgsToSrtPath,
                                ...attempt.flag,
                                `--input=${inputPath}`,
                                `--output=${outPath}`,
                                `--tesseractlanguage=${tessLang}`,
                                "--tesseractversion=5"
                            ];
                            log(jobLog, `🔄 PgsToSrt ${attempt.label}`);
                            log(jobLog, `📋 Command: ${dotnetPath} ${argsList.join(" ")}`);
                            execFileSync(dotnetPath, argsList, { stdio: "inherit" });

                            if (fs.existsSync(outPath)) {
                                sanitizeSrtFile(outPath, jobLog);
                                ocrSuccess = true;
                                break;
                            }
                            log(jobLog, `⚠ PgsToSrt finished with no output for ${attempt.label}`);
                        } catch (err) {
                            lastErr = err;
                            log(jobLog, `🚨 PgsToSrt failed for ${attempt.label}: ${err.message}`);
                        }
                    }

                    if (!ocrSuccess) {
                        const errMsg = lastErr?.message || "no output produced";
                        log(jobLog, `🚫 Failed OCR for subtitle idx=${ffmpegIdx}: ${errMsg}`);
                        throw new Error(errMsg);
                    }
                } else {
                    log(jobLog, `⚠ Unsupported subtitle codec ${codec} at idx=${ffmpegIdx} → skipping`);
                    continue;
                }
            } catch (err) {
                log(jobLog, `🚨 Failed processing subtitle idx=${ffmpegIdx}: ${err.message}`);
                log(jobLog, `⏭ Skipping to next subtitle...`);
                continue;
            }

            if (!fs.existsSync(outPath)) {
                log(jobLog, `🚫 Expected output missing, not adding to manifest: ${outPath}`);
                log(jobLog, `⏭ Skipping to next subtitle...`);
                continue;
            }

            manifestEntries.push({
                file: outFile, index: manifestIndex, lang, codec, forced,
                title: preserveMetadata ? title : "",
                hearingImpaired, visualImpaired, isDefault, isComment,
                isImageBased: codec.includes("pgs") || codec.includes("hdmv")
            });
        }

        // Transfer default from image-based (OCR) subtitles to text subtitles if option is enabled
        if (preferTextDefault) {
            // Find a non-OCR, non-commentary text subtitle candidate
            const findTextCandidate = (preferLang) => {
                // Prefer same language first
                let idx = manifestEntries.findIndex(e =>
                    !e.isImageBased && !e.isComment && e.lang === preferLang
                );
                // Fall back to any non-OCR, non-commentary
                if (idx === -1) {
                    idx = manifestEntries.findIndex(e =>
                        !e.isImageBased && !e.isComment
                    );
                }
                return idx;
            };

            const defaultImageIdx = manifestEntries.findIndex(e => e.isDefault && e.isImageBased);
            const anyExplicitDefault = manifestEntries.some(e => e.isDefault);
            const firstIsImageBased = manifestEntries.length > 0 && manifestEntries[0].isImageBased;

            if (defaultImageIdx !== -1) {
                // An OCR subtitle has the explicit default flag — transfer it to a text subtitle
                const candidateIdx = findTextCandidate(manifestEntries[defaultImageIdx].lang);
                if (candidateIdx !== -1) {
                    manifestEntries.forEach(e => {
                        if (e.isDefault && e.isImageBased) {
                            log(jobLog, `🔄 Removing default from OCR subtitle: ${e.file}`);
                            e.isDefault = 0;
                        }
                    });
                    manifestEntries[candidateIdx].isDefault = 1;
                    log(jobLog, `🔄 Setting default on text subtitle: ${manifestEntries[candidateIdx].file}`);
                } else {
                    log(jobLog, `ℹ No eligible text subtitle found to transfer default — keeping OCR subtitle as default`);
                }
            } else if (!anyExplicitDefault && firstIsImageBased) {
                // No explicit default, but the first track is OCR (implicit default by order) — set a text subtitle as default
                const candidateIdx = findTextCandidate(manifestEntries[0].lang);
                if (candidateIdx !== -1) {
                    manifestEntries[candidateIdx].isDefault = 1;
                    log(jobLog, `🔄 Setting default on text subtitle (first track is OCR, no explicit default): ${manifestEntries[candidateIdx].file}`);
                }
            }
        }

        // Reorder manifest so the default subtitle is first
        // (MP4Box defaults the first track; ffmpeg uses disposition flags but order still matters)
        const defaultManifestIdx = manifestEntries.findIndex(e => e.isDefault);
        if (defaultManifestIdx > 0) {
            const [defaultEntry] = manifestEntries.splice(defaultManifestIdx, 1);
            manifestEntries.unshift(defaultEntry);
            log(jobLog, `🔄 Reordered manifest: moved default subtitle to first position: ${defaultEntry.file}`);
        }

        // Write manifest entries
        // Manifest format: file|index|lang|codec|forced|title|hearing_impaired|visual_impaired|default|comment
        for (const entry of manifestEntries) {
            const line = [
                entry.file, entry.index, entry.lang, entry.codec, entry.forced,
                entry.title, entry.hearingImpaired, entry.visualImpaired,
                entry.isDefault, entry.isComment
            ].join("|") + "\n";
            fs.appendFileSync(exportsFile, line);
        }

        log(jobLog, "=== Extract All Subtitles Plugin End ===");

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables
        };
    };
    exports.plugin = plugin;

})(); // end closure
