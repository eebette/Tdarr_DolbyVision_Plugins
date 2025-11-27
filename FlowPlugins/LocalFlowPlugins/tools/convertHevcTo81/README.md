# Convert HEVC7 to 8.1
- Converts DV7 BL HEVC to DV8.1 compatible stream via dovi_tool and ffmpeg.
- Inputs:
  - `Dovi Tool Path` (string, default `{{{args.variables.doviToolBin}}}`).
  - `BL HEVC Path` (string, optional; defaults to Tdarr cache `<basename>.hevc`).
  - `Output Directory` (string, optional; defaults to Tdarr cache).
- Produces a DV8.1 HEVC in the chosen directory; skips steps if outputs already exist.
- Dependencies: `dovi_tool`, ffmpeg; install dovi_tool via Install DV Tools plugin.
