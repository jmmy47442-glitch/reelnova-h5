# MP4 validation fixtures

Synthetic 160 × 90 blue video with a generated 440 Hz tone. No third-party media.

Generated with FFmpeg using `color=c=blue:s=160x90:r=10` and `sine=frequency=440:sample_rate=44100`, `-t 1 -c:v libx264 -pix_fmt yuv420p -profile:v baseline -c:a aac -b:a 32k`.

- `compatible.mp4`: uses `-t 12` for browser seek/resume checks and adds `-movflags +faststart`.
- `no-faststart.mp4`: ordinary moov-at-end output, rejected for new uploads but supported for legacy R2 playback via Range requests.
- `unsupported-video.mp4`: overrides video with `-c:v mpeg4 -profile:v 0`, adds faststart; rejected despite the MP4 extension.
