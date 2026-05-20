# Manual test checklist (v1)

Until we set up an integration test rig, run through this before tagging a
release. The whole loop should take ~10 minutes on a 5-minute test clip.

## Setup

- [ ] `git clean -fdx && npm ci && cargo build --manifest-path src-tauri/Cargo.toml`
- [ ] `./src-tauri/binaries/fetch.sh` reports all three binaries present
- [ ] `npm run tauri:dev` launches with no console errors

## Import + transcribe

- [ ] Drag a `.mp4` onto the window → metadata appears in the sidebar
- [ ] Filename, resolution, duration are correct vs. `ffprobe` on the CLI
- [ ] Click **Transcribe**, pick `large-v3-turbo`, accept download prompt
- [ ] Progress bar advances; final transcript appears
- [ ] Click any word → video seeks to that timestamp
- [ ] Words highlight as the video plays

## Edit

- [ ] Select two adjacent words → press Delete → words show as struck-through
- [ ] Hit Play → audio skips the deleted range cleanly (no audible artefact)
- [ ] Cmd+Z restores the deletion
- [ ] Repeat with a longer range crossing a paragraph boundary
- [ ] Select a leading word → delete → segment trims from the start
- [ ] Select a trailing word → delete → segment trims from the end

## Save / load

- [ ] Cmd+S → choose location → `.scribe` bundle appears on disk
- [ ] Quit and relaunch
- [ ] Recent files menu shows the project; opening it restores all edits
- [ ] Move the source media file; relaunch → relink dialog appears; selecting
      the new path completes successfully

## Export

- [ ] Cmd+E → choose output → progress bar advances
- [ ] Output `.mp4` plays in QuickTime
- [ ] Output duration matches `totalDuration(project)` (within ±100ms)
- [ ] No audio glitches at cut boundaries
- [ ] Cancel works: hitting Cancel mid-export terminates ffmpeg promptly

## Performance smoke check (M2 Pro)

- [ ] 5-minute clip transcribes in < 60s with `large-v3-turbo`
- [ ] 5-minute edit exports (re-encode-all) in < 30s
