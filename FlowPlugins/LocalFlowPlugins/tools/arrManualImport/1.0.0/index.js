"use strict";

(function () {

    Object.defineProperty(exports, "__esModule", { value: true });
    exports.plugin = exports.details = void 0;

    /**
     * Import the working file into Radarr/Sonarr via their Manual Import command.
     *
     * The arr instance parses the file, decides the final name from its own naming
     * policy and mediainfo, and moves (or copies) the file into the library folder
     * in one step. The file never exists in the library under any other name, so
     * folder watchers and Bazarr only ever see the final file.
     *
     * Every value sent to the import command comes from the arr's own parse of the
     * file (GET /api/v3/manualimport): series/movie, episodes, quality, languages,
     * release group. Nothing is guessed here. Any rejection reported by the arr
     * fails the plugin.
     */

    const fs = require("fs");
    const http = require("http");
    const https = require("https");

    const POLL_INTERVAL_MS = 2000;

    function log(jobLog, msg) {
        jobLog(msg);
        console.log(msg);
    }

    // Minimal JSON HTTP client on node built-ins; no dependency on Tdarr's bundled axios.
    function httpJson(method, url, headers, body, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const mod = u.protocol === "https:" ? https : http;
            const payload = body === undefined ? null : JSON.stringify(body);
            const req = mod.request(
                {
                    method,
                    hostname: u.hostname,
                    port: u.port || (u.protocol === "https:" ? 443 : 80),
                    path: u.pathname + u.search,
                    headers: {
                        Accept: "application/json",
                        ...headers,
                        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
                    },
                    timeout: timeoutMs,
                },
                (res) => {
                    let data = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk) => { data += chunk; });
                    res.on("end", () => {
                        let parsed = null;
                        if (data) {
                            try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                        }
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            const detail = typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300);
                            return reject(new Error(`${method} ${u.pathname} -> HTTP ${res.statusCode}: ${detail}`));
                        }
                        resolve(parsed);
                    });
                }
            );
            req.on("timeout", () => req.destroy(new Error(`${method} ${u.pathname} timed out after ${timeoutMs} ms`)));
            req.on("error", reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    const details = () => ({
        name: "Import into Radarr/Sonarr (Manual Import)",
        description:
            "Hands the working file to Radarr/Sonarr's Manual Import command. The arr names the file from its own "
            + "naming policy and moves it into the library in one step, so no watcher ever sees an interim name. "
            + "All import parameters come from the arr's own parse of the file; any rejection fails the flow. "
            + "The working file becomes the imported library file.",
        style: { borderColor: "green" },
        tags: "arr,radarr,sonarr,import",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: 9,
        icon: "faFileImport",
        inputs: [
            {
                label: "Arr",
                name: "arr",
                tooltip: "Radarr or Sonarr",
                inputType: "string",
                defaultValue: "radarr",
                inputUI: { type: "dropdown", options: ["radarr", "sonarr"] },
            },
            {
                label: "Arr API Key",
                name: "arr_api_key",
                tooltip: "API key of the arr instance that owns the destination library.",
                inputType: "string",
                defaultValue: "",
                inputUI: { type: "text" },
            },
            {
                label: "Arr Host",
                name: "arr_host",
                tooltip: "Base URL of the arr instance, e.g. http://192.168.1.1:7878. The arr must see the working file at the same path as this node.",
                inputType: "string",
                defaultValue: "http://192.168.1.1:7878",
                inputUI: { type: "text" },
            },
            {
                label: "Import Mode",
                name: "importMode",
                tooltip: "move: the arr moves the working file into the library (atomic rename on the same filesystem). copy: the arr copies it and the working file stays in the cache.",
                inputType: "string",
                defaultValue: "move",
                inputUI: { type: "dropdown", options: ["move", "copy"] },
            },
            {
                label: "Timeout (seconds)",
                name: "timeoutSeconds",
                tooltip: "How long to wait for the arr's import command to complete.",
                inputType: "number",
                defaultValue: 900,
                inputUI: { type: "text" },
            },
        ],
        outputs: [{ number: 1, tooltip: "Imported; working file is now the library file" }],
    });
    exports.details = details;

    async function waitForCommand(jobLog, host, headers, commandId, timeoutMs) {
        const start = Date.now();
        let last = "";
        while (Date.now() - start < timeoutMs) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            const cmd = await httpJson("GET", `${host}/api/v3/command/${commandId}`, headers);
            const status = String(cmd.status || "");
            if (status !== last) {
                log(jobLog, `⏳ Command ${commandId}: ${status}`);
                last = status;
            }
            if (status === "completed") return cmd;
            if (status === "failed" || status === "aborted" || status === "cancelled") {
                throw new Error(`Manual import command ${commandId} ended with status '${status}': ${cmd.message || cmd.exception || "no details"}`);
            }
        }
        throw new Error(`Manual import command ${commandId} did not complete within ${Math.round(timeoutMs / 1000)} s`);
    }

    const plugin = async (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const jobLog = args.jobLog;
        log(jobLog, "=== Arr Manual Import Start ===");

        const arr = String(args.inputs.arr || "").trim().toLowerCase();
        if (arr !== "radarr" && arr !== "sonarr") throw new Error(`Unsupported arr '${arr}'`);
        const hostRaw = String(args.inputs.arr_host || "").trim();
        const host = hostRaw.endsWith("/") ? hostRaw.slice(0, -1) : hostRaw;
        if (!host) throw new Error("Arr Host is empty");
        const apiKey = String(args.inputs.arr_api_key || "").trim();
        if (!apiKey) throw new Error("Arr API Key is empty");
        const importMode = String(args.inputs.importMode || "move").trim().toLowerCase();
        if (importMode !== "move" && importMode !== "copy") throw new Error(`Unsupported import mode '${importMode}'`);
        const timeoutMs = Math.max(30, Number(args.inputs.timeoutSeconds) || 900) * 1000;
        const headers = { "X-Api-Key": apiKey };

        const filePath = args.inputFileObj._id;
        if (!fs.existsSync(filePath)) throw new Error(`Working file not found: ${filePath}`);
        const sourceSize = fs.statSync(filePath).size;
        log(jobLog, `📄 File: ${filePath} (${sourceSize} bytes)`);
        log(jobLog, `🔗 ${arr} at ${host} | mode=${importMode}`);

        // 1. Let the arr parse the file. Passing the file path (not its folder) returns exactly this file.
        const url = `${host}/api/v3/manualimport?folder=${encodeURIComponent(filePath)}&filterExistingFiles=true`;
        const items = await httpJson("GET", url, headers);
        if (!Array.isArray(items)) throw new Error(`Unexpected manualimport response: ${JSON.stringify(items).slice(0, 300)}`);
        const item = items.find((i) => i.path === filePath) || (items.length === 1 ? items[0] : null);
        if (!item) throw new Error(`${arr} did not return a manual import item for ${filePath} (got ${items.length} items)`);

        const rejections = (item.rejections || []).map((r) => r.reason || JSON.stringify(r));
        if (rejections.length) throw new Error(`${arr} rejected the file: ${rejections.join("; ")}`);
        const qualityName = item.quality?.quality?.name;
        if (!qualityName) throw new Error(`${arr} could not determine quality for ${filePath}`);

        let file;
        let lookupUrl;
        if (arr === "sonarr") {
            const seriesId = item.series?.id;
            const episodeIds = (item.episodes || []).map((e) => e.id);
            if (!seriesId || !episodeIds.length) {
                throw new Error(`sonarr could not match the file to a series/episode (series=${seriesId}, episodes=${episodeIds.length})`);
            }
            log(jobLog, `🎯 ${item.series.title} S${String(item.seasonNumber).padStart(2, "0")} episodes ${item.episodes.map((e) => e.episodeNumber).join(",")} | ${qualityName} | ${item.releaseGroup || "no group"}`);
            file = { path: filePath, seriesId, episodeIds, quality: item.quality, languages: item.languages || [], releaseGroup: item.releaseGroup || "", indexerFlags: item.indexerFlags || 0 };
            lookupUrl = `${host}/api/v3/episode/${episodeIds[0]}`;
        } else {
            const movieId = item.movie?.id;
            if (!movieId) throw new Error("radarr could not match the file to a movie");
            log(jobLog, `🎯 ${item.movie.title} (${item.movie.year}) | ${qualityName} | ${item.releaseGroup || "no group"}`);
            file = { path: filePath, movieId, quality: item.quality, languages: item.languages || [], releaseGroup: item.releaseGroup || "", indexerFlags: item.indexerFlags || 0 };
            lookupUrl = `${host}/api/v3/movie/${movieId}`;
        }

        // 2. Import. The arr computes the final name and moves/copies the file itself.
        const cmd = await httpJson("POST", `${host}/api/v3/command`, headers, { name: "ManualImport", importMode, files: [file] });
        if (!cmd || !cmd.id) throw new Error(`Manual import command was not queued: ${JSON.stringify(cmd).slice(0, 300)}`);
        log(jobLog, `🚚 Manual import queued (command ${cmd.id})`);
        await waitForCommand(jobLog, host, headers, cmd.id, timeoutMs);

        // 3. Ask the arr where the file ended up, then confirm that file is ours by size.
        // Nodes may see the library over NFS, where a just-renamed path can stay visible
        // for a while, so the old path is not evidence of anything; the new path's size is.
        const res = await httpJson("GET", lookupUrl, headers);
        const newPath = arr === "sonarr" ? res.episodeFile?.path : res.movieFile?.path;
        if (!newPath) throw new Error(`${arr} reports no file for the imported item after the command completed`);
        let newSize = -1;
        for (let attempt = 0; attempt < 15; attempt += 1) {
            try { newSize = fs.statSync(newPath).size; } catch (_) { newSize = -1; }
            if (newSize === sourceSize) break;
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (newSize !== sourceSize) {
            throw new Error(`${arr} reports the file at ${newPath} but this node sees size ${newSize}, expected ${sourceSize}`);
        }
        if (importMode === "move" && fs.existsSync(filePath)) {
            log(jobLog, `⚠ Working file still visible at ${filePath} after the move (stale network cache or copy fallback); the cache is cleaned at job end`);
        }
        log(jobLog, `✅ Imported as: ${newPath}`);
        log(jobLog, "=== Arr Manual Import End ===");

        return {
            outputFileObj: { _id: newPath },
            outputNumber: 1,
            variables: { ...args.variables, arrImportedPath: newPath },
        };
    };

    exports.plugin = plugin;

})();
