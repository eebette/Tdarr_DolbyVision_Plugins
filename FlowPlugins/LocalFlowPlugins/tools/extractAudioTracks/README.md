# Extract Audio Tracks
- Exports DV7 audio streams with optional TrueHD/DTS→EAC3 conversion using ffmpeg.
- Inputs:
  - `Output Directory` (string, optional; defaults to Tdarr cache).
  - `Convert TrueHD/DTS to EAC3` (boolean, default true).
- Output files are named `<basename>_<id>.<lang>.<ext>` plus an audio exports manifest
  `<basename>_audio.exports` in the output directory.
- Skips unsupported codecs; logs per-stream actions.
- Dependencies: ffmpeg available on PATH.
