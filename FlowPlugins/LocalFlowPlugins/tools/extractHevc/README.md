# Extract HEVC from DV7
- Extracts the BL7 HEVC track from the source file using ffmpeg.
- Default output dir: Tdarr cache; override with `Output Directory` (string).
- Output file naming: `<basename>.hevc` in the chosen directory.
- Skips extraction if the HEVC already exists.
- Dependencies: ffmpeg available on PATH; none of the DV tools required for this step.
