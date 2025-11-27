# Extract RPU from DV7
- Uses `dovi_tool extract-rpu` to pull the Dolby Vision RPU from a BL7 HEVC.
- Inputs:
  - `Dovi Tool Path` (string, default `{{{args.variables.doviToolBin}}}`).
  - `BL HEVC Path` (string, optional; defaults to Tdarr cache `<basename>.hevc`).
  - `Output Directory` (string, optional; defaults to Tdarr cache).
- Output file naming: `<basename>_RPU.bin` in the chosen directory; skips if present.
- Dependencies: `dovi_tool` binary (install via Install DV Tools plugin).
