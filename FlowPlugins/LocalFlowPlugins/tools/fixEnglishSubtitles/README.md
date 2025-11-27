# Fix English Subtitles
- Cleans common OCR errors in English SRT files listed in `subtitles.exports`.
- Inputs:
  - `Subtitles Directory` (string, optional; defaults to Tdarr cache).
- Finds `<basename>_subtitles.exports` (or legacy `subtitles.exports`) in the dir.
- Only edits `eng/en` entries; others are untouched. Writes updates in place.
- Dependencies: none beyond Node runtime; relies on prior subtitle extraction step.
