"use strict";

/**
 * Filter plugin: checks if the input file is Dolby Vision Profile 7.
 * Routes to output 1 when DV7, otherwise output 2.
 */

(function () {
    Object.defineProperty(exports, "__esModule", {value: true});
    exports.plugin = exports.details = void 0;

    const details = () => ({
        name: "Check Dolby Vision 7",
        description: "Filter: is the video Dolby Vision Profile 7?",
        style: {borderColor: "orange"},
        tags: "video",
        isStartPlugin: false,
        pType: "",
        requiresVersion: "2.11.01",
        sidebarPosition: -1,
        icon: "faQuestion",
        inputs: [],
        outputs: [
            {number: 1, tooltip: "File is Dolby Vision Profile 7"},
            {number: 2, tooltip: "File is NOT Dolby Vision Profile 7"},
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

        let isDV7 = false;

        for (let i = 0; i < streams.length; i++) {
            const stream = streams[i];
            if (stream.codec_type !== "video") continue;

            const codec = (stream.codec_name || "").toLowerCase();
            const sideDataList = stream.side_data_list || [];
            const dvSide = sideDataList.find(sd => typeof sd?.dv_profile !== "undefined");

            if (dvSide && Number(dvSide.dv_profile) === 7 && codec === "hevc") {
                isDV7 = true;
                break;
            }

            const title =
                (stream.tags?.title || args.inputFileObj?.ffProbeData?.format?.tags?.title || "")
                    .toLowerCase();
            if (title.includes("profile 7") || title.includes("dolby vision 7")) {
                if (codec === "hevc") {
                    isDV7 = true;
                    break;
                }
            }
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: isDV7 ? 1 : 2,
            variables: args.variables,
        };
    };
    exports.plugin = plugin;

})(); // end closure
