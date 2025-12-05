# Cleanup DV Cache

## Description

This plugin deletes all Dolby Vision processing cache files for the current file from the Tdarr cache directory.

## What Gets Deleted

The plugin searches for and deletes the following files:

### Always Deleted:
- **BL HEVC file** - `{basename}.hevc`
- **Audio exports manifest** - `{basename}_audio.exports`
- **Subtitle exports manifest** - `{basename}_subtitles.exports`
- **RPU file** - `{basename}_RPU.bin`
- **All audio track files** - Listed in the audio exports manifest (e.g., `.eac3`, `.ac3`, `.mka`, `.thd`, `.dts`)
- **All subtitle track files** - Listed in the subtitle exports manifest (e.g., `.srt`)

### Optionally Deleted:
- **Output MP4 file** - `{basename}.mp4` (controlled by "Delete Output MP4" setting)

## Use Cases

### Use Case 1: Clean Up After Failed Processing
If a DV processing workflow fails partway through, use this plugin to clean up partial files before retrying.

### Use Case 2: Free Up Cache Space
After successfully creating the final MP4, use this plugin to remove all intermediate processing files.

### Use Case 3: Full Reset
Enable "Delete Output MP4" to completely remove all DV-related files and start fresh.

## Inputs

### Cache Directory (Optional)
- **Default**: Uses Tdarr's cache directory
- **Override**: Specify a custom directory containing the cache files

### Delete Output MP4
- **Default**: `false` (disabled)
- **Enabled**: Also deletes the final output MP4 file
- **Use with caution**: Only enable if you want to completely remove all DV processing output

## Output

The plugin reports:
- ✓ Files found and successfully deleted
- ⚠️ Files skipped or failed to delete
- Total count of deleted and skipped files

## Safety

- Only deletes files matching the expected patterns for the current file
- Will not delete files from other processing jobs
- Reports any deletion failures without stopping execution
- By default, preserves the output MP4 file

## Example Workflow Position

```
1. Extract Audio Tracks
2. Extract Subtitles
3. Convert HEVC to DV8.1
4. Build DV8.1 MP4
5. Cleanup DV Cache  ← Clean up intermediate files after successful build
```

Or for troubleshooting:

```
1. Extract Audio Tracks (FAILED)
2. Cleanup DV Cache (Delete Output MP4: false)  ← Remove partial files
3. [Retry from step 1]
```
