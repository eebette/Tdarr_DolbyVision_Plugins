# Check Dolby Vision 7
- Filter plugin to test if the input video is Dolby Vision Profile 7 (HEVC).
- No inputs. Outputs:
  - 1: File is DV Profile 7.
  - 2: File is not DV Profile 7.
- Detection uses ffprobe stream side_data (dv_profile === 7) or title hints (profile 7) on video streams.
- Throws if ffprobe stream data is missing.
- Dependencies: none beyond ffprobe data supplied by Tdarr; no external binaries required.
