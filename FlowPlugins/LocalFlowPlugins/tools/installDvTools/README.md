# Install DV Tools
- Installs MP4Box (GPAC), dovi_tool, dotnet runtime, PgsToSrt, tessdata into a user dir.
- Default install dir: `$HOME/opt` or the provided `Install Directory` input.
- MP4Box and libjpeg are extracted to `gpac/usr/bin` and `gpac/usr/lib` under the install dir.
- Output variables: `mp4boxBin`, `mp4boxLibDir`, `doviToolBin`, `dotnetBin`, `pgsToSrtDll`, `dvToolsInstalled`.
- Input `Install Directory` (string, default empty) chooses the root install path.
- Requires outbound network to download archives; uses `wget`, `dpkg-deb`, `tar`, `unzip`.
