# Extract PGS Subtitles
- Extracts one subtitle per language, preferring text; OCRs PGS to SRT when needed.
- Inputs:
  - `Dotnet Path` (string, default `{{{args.variables.dotnetBin}}}`).
  - `PgsToSrt Path` (string, default `{{{args.variables.pgsToSrtDll}}}`).
  - `Output Directory` (string, optional; defaults to Tdarr cache).
- Outputs subtitles to the chosen directory and writes `<basename>_subtitles.exports`.
- Dependencies: ffmpeg, mkvinfo, dotnet runtime, PgsToSrt, tessdata (install via
  Install DV Tools). Requires network only during those installs.
