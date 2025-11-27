"use strict";

/**
 * Filter plugin: checks if the input file is Dolby Vision Profile 8.x (excluding 8.1).
 * Routes to output 1 when DV8.x (not 8.1), otherwise output 2.
 */

(function () {
    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    const details = () => ({
        name: "Check Dolby Vision 8.x (not 8.1)",
        description: "Filter: is the video Dolby Vision Profile 8.x excluding 8.1?",
        style: {borderColor: "orange"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: -1,
        icon: "faQuestion",
        inputs: [],
        outputs: [
            {number: 1, tooltip: "File is Dolby Vision Profile 8.x (not 8.1)"},
            {number: 2, tooltip: "File is NOT Dolby Vision Profile 8.x (or is 8.1)"},
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

        let isDV8x = false;

        for (let i = 0; i < streams.length; i++) {
            const stream = streams[i];
            if (stream.codec_type !== "video") continue;

            const sideDataList = stream.side_data_list || [];
            const dvSide = sideDataList.find(sd => typeof sd?.dv_profile !== "undefined");

            if (dvSide && Number(dvSide.dv_profile) === 8) {
                const compat = Number(dvSide.dv_bl_signal_compatibility_id);
                // Exclude 8.1 (compat == 1), accept other 8.x
                if (compat !== 1) {
                    isDV8x = true;
                    break;
                }
            }

            const title =
                (stream.tags?.title || args.inputFileObj?.ffProbeData?.format?.tags?.title || "")
                    .toLowerCase();
            if (title.includes("profile 8.") || title.includes("dv8.")) {
                // If title explicitly says 8.1, treat as not matching this filter
                if (title.includes("8.1") || title.includes("8,1")) continue;
                isDV8x = true;
                break;
            }
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: isDV8x ? 1 : 2,
            variables: args.variables,
        };
    };
    exports.plugin = plugin;

})(); // end closure
