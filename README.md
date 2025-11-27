# Tdarr_Flows

Flow plugins for Tdarr focused on Dolby Vision (DV) handling: extract, convert, and remux HEVC streams into MP4 with correct DV metadata for devices with limited codec support (e.g., LG OLED, Apple TV, web players).

## Why this exists
- Existing “all-in-one” FFmpeg approaches are unreliable for DV: `-strict unofficial` is experimental, metadata can be dropped, and profiles aren’t explicit.
- Many TVs/players struggle with MKV + dual-layer DV or non-HEVC codecs; these flows convert to DV Profile 8.1 MP4 with explicit profile flags.
- Builds on community knowledge: inspired by workflows from [reddit](https://old.reddit.com/r/ffmpeg/comments/11gu4o4/convert_dv_profile_7_to_81_using_dovi_tool_mp4box/jn5gman/), [dvmkv2mp4](https://github.com/gacopl/dvmkv2mp4), and [Tdarr_Plugins_DoVi](https://github.com/andrasmaroy/Tdarr_Plugins_DoVi).

## Approach
- Extract video (HEVC), audio, and subtitle tracks; extract RPU where present.
- Convert DV Profile 7/5 streams to Profile 8.1 when needed (dovi_tool).
- Remux with MP4Box using explicit `dvp=` flags so DV metadata is preserved and player-friendly.
- Favor MP4Box over “FFmpeg with -strict unofficial” for DV because:
  - MP4Box advantages: native DV support, explicit profile control, proper RPU handling, better metadata preservation, granular flags.
  - MP4Box trade-offs: needs demuxed inputs, more syntax overhead.
  - FFmpeg quick path pros: single command, copies all streams, faster.
  - FFmpeg quick path cons: experimental DV handling, profile ambiguity, weaker metadata preservation, device compatibility risk.

## Install on a Tdarr instance
1) Clone this repo onto the Tdarr server: `git clone https://github.com/<your>/Tdarr_Flows.git`
2) Run the installer (copies only plugin `index.js` files):
   ```bash
   ./scripts/install_flow_plugins.sh /path/to/tdarr/server
   ```
   - Example Tdarr root: `/opt/tdarr` ⇒ plugins land in `/opt/tdarr/Tdarr/Plugins/FlowPlugins`.
3) Restart Tdarr so new flows appear in the UI.

## System dependencies
- `ffmpeg` (with HEVC/H.265 and 10-bit support; `-strict unofficial` not required for these flows).
- `MP4Box` (GPAC) built with DV support.
- `dovi_tool` for RPU conversion and DV profile transforms.
- `x265` (via ffmpeg’s `libx265`) for re-encoding non-HEVC inputs to HEVC/DV-friendly streams.
- Sufficient disk for temp/cache outputs (Tdarr cache directory).

## What you can do with these flows
- Detect DV metadata (any profile) for routing pipelines.
- Extract HEVC (or transcode non-HEVC to HEVC) and RPUs.
- Convert DV P7/P5 to P8.1 for single-layer compatibility.
- Remux into MP4 with MP4Box, keeping audio/subtitle language, names, and DV metadata intact.

## Notes and caveats
- MP4Box paths and dovi_tool paths must be set in Tdarr variables/inputs.
- Non-HEVC sources are re-encoded (configurable preset/CRF) before DV remux.
- Demuxed intermediate files may be deleted automatically depending on plugin settings.
