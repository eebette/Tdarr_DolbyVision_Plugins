"use strict";

/**
 * Filter plugin: checks if the input file contains any Dolby Vision metadata.
 * Routes to output 1 when DV is detected (any profile), otherwise output 2.
 */

(function () {
    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    const details = () => ({
        name: "Check Dolby Vision",
        description: "Filter: does the file contain any Dolby Vision metadata?",
        style: {borderColor: "orange"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: -1,
        icon: "faQuestion",
        inputs: [],
        outputs: [
            {number: 1, tooltip: "File has Dolby Vision metadata"},
            {number: 2, tooltip: "File does NOT have Dolby Vision metadata"},
        ],
    });
    exports.details = details;

    const plugin = (args) => {
        const lib = require("../../../../../methods/lib")();
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        const streams = args?.inputFileObj?.ffProbeData?.streams;
        if (!Array.isArray(streams)) {
            throw new Error("File has no stream data");
        }

        let hasDV = false;
        let detectedProfile = "";

        for (let i = 0; i < streams.length; i++) {
            const stream = streams[i];
            if (stream.codec_type !== "video") continue;

            const sideDataList = stream.side_data_list || [];
            const dvSide = sideDataList.find(
                (sd) =>
                    typeof sd?.dv_profile !== "undefined" ||
                    (typeof sd?.side_data_type === "string" && sd.side_data_type.toLowerCase().includes("dovi"))
            );

            if (dvSide) {
                hasDV = true;
                detectedProfile = typeof dvSide.dv_profile !== "undefined" ? String(dvSide.dv_profile) : "unknown";
                break;
            }

            const codecTag = (stream.codec_tag_string || "").toLowerCase();
            const codecName = (stream.codec_name || "").toLowerCase();

            // Common DV codec tags for MP4/MKV: dvh1/dvh3/dva1/dvb1/dvhe
            if (codecTag.startsWith("dv")) {
                hasDV = true;
                detectedProfile = codecTag;
                break;
            }

            // Title/tag fallback hints
            const title =
                (stream.tags?.title || args.inputFileObj?.ffProbeData?.format?.tags?.title || "")
                    .toLowerCase();
            if (title.includes("dolby vision") || title.includes("dv profile") || title.includes("dv8") || title.includes("dv7") || title.includes("dv5")) {
                hasDV = true;
                detectedProfile = title;
                break;
            }

            // HEVC stream with dvhe codec_name (seen in some probes)
            if (codecName.startsWith("dv")) {
                hasDV = true;
                detectedProfile = codecName;
                break;
            }
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: hasDV ? 1 : 2,
            variables: {
                ...args.variables,
                dvProfileDetected: hasDV ? detectedProfile : "",
            },
        };
    };
    exports.plugin = plugin;

})(); // end closure
