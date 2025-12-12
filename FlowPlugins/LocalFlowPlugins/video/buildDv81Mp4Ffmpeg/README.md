# Build DV8.1 MP4 (FFmpeg)

Remuxes Dolby Vision 8.1 content into MP4 using ffmpeg by copying the video stream bit-for-bit from the input file and adding audio/subtitle tracks from manifest files.

## Key Differences from buildDv81Mp4

This plugin differs from the standard `buildDv81Mp4` plugin in two important ways:

1. **Uses ffmpeg instead of MP4Box** - May have better compatibility with certain players or workflows
2. **Copies video from input file** - Instead of using a converted HEVC file, it copies the video stream directly from the source file (bit-for-bit, no re-encoding)

## Use Case

Use this plugin when:
- You want to remux without converting the video stream
- Your source file already contains DV 8.1 compatible video (typically in MKV container)
- You prefer ffmpeg over MP4Box for the remux operation
- You've extracted audio/subtitle tracks and want to recombine them with the original video into MP4 format

**Typical scenario**: Input video is in MKV container with DV 8.1 video stream, and you want to remux it into MP4 with selected audio/subtitle tracks.

## Inputs

- **Audio Exports Path** (string, optional): Path to `audio.exports` manifest. Defaults to `<cache>/<basename>_audio.exports`.
- **Subtitle Exports Path** (string, optional): Path to `subtitles.exports` manifest. Defaults to `<cache>/<basename>_subtitles.exports`.
- **Output Directory** (string, optional): Directory for output MP4. Defaults to Tdarr cache directory.
- **Delete Sources After Remux** (boolean, default `true`): Delete audio/subtitle exports and track files after successful remux.

## Outputs

- **Output 1**: Continue to next step
- **outputFileObj**: Points to the newly created MP4 file
- **variables.generatedMp4Path**: Path to the generated MP4 file

## Process

1. Reads `audio.exports` and `subtitles.exports` manifest files
2. Builds ffmpeg command with:
   - Video stream copied from input file (`-c:v copy`) with:
     - `-bsf:v hevc_mp4toannexb` - Converts HEVC to Annex B format
     - `-tag:v hvc1` - Sets the video codec tag to hvc1 for MP4 compatibility
     - `-strict unofficial` - Allows unofficial codec features
   - All audio tracks from manifest with proper metadata (`-c:a copy`)
   - All subtitle tracks from manifest with proper metadata (`-c:s mov_text`)
   - Language tags, titles, and disposition flags
   - `-f mp4` - Forces MP4 container format output
3. Executes ffmpeg to create MP4
4. Optionally deletes source files
5. Returns new MP4 as output

## Dependencies

- `ffmpeg` available on PATH

## Example Flow

```
Input File (MKV with DV 8.1) → Extract Audio Tracks → Extract Subtitles → Build DV8.1 MP4 (FFmpeg)
```

## Notes

- The video stream is copied bit-for-bit with no conversion (works with MKV or other containers)
- Output file always has `.mp4` extension regardless of input file extension
- MP4 container format is explicitly forced with `-f mp4` flag
- Video stream arguments ensure proper Dolby Vision compatibility:
  - `hevc_mp4toannexb` bitstream filter ensures proper NAL unit format
  - `hvc1` tag provides MP4 container compatibility
  - `unofficial` flag allows Dolby Vision features
- Subtitle format is converted to `mov_text` for MP4 compatibility
- Audio is copied as-is (assumes compatible format for MP4)
- All track metadata (language, title, forced flag) is preserved
- Command is logged with `📋 Command:` prefix for debugging
