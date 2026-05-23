# Security Policy

## Supported versions

YusafCut is pre-1.0. Only the latest tagged release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Email the maintainers privately and include:

- A description of the issue and its impact
- Steps to reproduce
- Any proof-of-concept code

You should receive an acknowledgement within 72 hours. We aim to ship a fix or
publish mitigation guidance within 14 days for high-severity issues.

## Threat model (v0.x)

YusafCut is a **local-first** desktop application:

- All media stays on the user's machine.
- No telemetry, no analytics, no crash reporting to remote servers in v1.
- Network access is limited to: (a) model downloads from Hugging Face on first
  transcribe, (b) the auto-update manifest from GitHub Releases.

Threats we care about:

1. **Malicious project files (`.scribe`).** A crafted project that crashes or
   exploits the parser. We use `serde_json` with strict typing; report any
   crashes as bugs.
2. **Path traversal in media references.** Project files reference media by
   absolute path. We do not interpret relative paths or symlinks specially —
   please report any way to escape the user's intended directory.
3. **Sidecar binary integrity.** We verify SHA-256 of downloaded models before
   loading; if a verification step is bypassed, that's a security issue.

Threats we do **not** address:

- Hardware-level side channels.
- Malicious system administrators.
- The user opening malicious video files in `ffmpeg` directly.
