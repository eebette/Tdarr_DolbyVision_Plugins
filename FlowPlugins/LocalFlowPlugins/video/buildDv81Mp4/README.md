# Build DV8.1 MP4
- Remuxes DV8.1 HEVC, audio exports, subtitle exports, and RPU into an MP4 via MP4Box.
- Inputs:
  - `BL DV8.1 HEVC Path` (string, defaults to Tdarr cache `<basename>.hevc`).
  - `Audio Exports Path` (string, defaults to Tdarr cache `<basename>_audio.exports`).
  - `Subtitle Exports Path` (string, defaults to Tdarr cache `<basename>_subtitles.exports`).
  - `RPU Path` (string, defaults to Tdarr cache `<basename>_RPU.bin`).
  - `MP4Box Path` (string, default `{{{args.variables.mp4boxBin}}}`).
  - `Delete Sources After Remux` (boolean, default true).
- Output MP4: `<basename>.mp4` in the working directory.
- Applies track language/forced flags; names are unquoted with spaces escaped.
- Dependencies: MP4Box with libs available at `/home/Tdarr/opt/gpac/usr/lib` (set via
  LD_LIBRARY_PATH). Install via the Install DV Tools plugin.
