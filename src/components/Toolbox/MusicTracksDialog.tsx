/**
 * MusicTracksDialog — manage the audio tracks layered under the main EDL.
 *
 * The data model lives in `project.audioTracks`. Each track points at a
 * SourceMedia entry, gets a gain (dB) and offset, and optionally enables
 * sidechain ducking so the music drops under the speaker's voice during
 * export.
 *
 * UI strategy:
 *   * Plus button → file picker → `importMedia` → `addMediaOnly` →
 *     `addAudioTrack`. The track inherits the imported media's id.
 *   * Each row exposes gain slider, offset input, "Duck under voice" toggle,
 *     remove button.
 *   * No track preview yet — multi-track playback in the browser is a Tier 2
 *     item; the mix is audible in the final export.
 */

import { useCallback, useMemo } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Music, Plus, Trash2 } from "lucide-react";
import { importMedia } from "@/lib/ipc";
import { projectAudioTracks, type AudioTrack } from "@/lib/edl";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";

const MEDIA_EXTENSIONS = ["mp3", "m4a", "wav", "aac", "flac", "ogg", "mp4", "mov"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MusicTracksDialog({ open, onOpenChange }: Props) {
  const project = useProjectStore((s) => s.project);
  const addAudioTrack = useProjectStore((s) => s.addAudioTrack);
  const removeAudioTrack = useProjectStore((s) => s.removeAudioTrack);
  const updateAudioTrack = useProjectStore((s) => s.updateAudioTrack);
  const addMediaOnly = useProjectStore((s) => s.addMediaOnly);
  const pushToast = useUIStore((s) => s.pushToast);

  const tracks = useMemo(() => projectAudioTracks(project), [project]);

  const handleAdd = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Audio", extensions: MEDIA_EXTENSIONS }],
    });
    if (typeof picked !== "string") return;
    try {
      const media = await importMedia(picked);
      addMediaOnly(media);
      addAudioTrack({
        mediaId: media.id,
        gainDb: -12,
        offsetSec: 0,
        ducks: true,
      });
      pushToast({
        title: "Music track added",
        description: media.path.split(/[\\/]/).pop() ?? media.path,
      });
    } catch (err) {
      pushToast({
        title: "Failed to add music track",
        description: String(err),
        variant: "destructive",
      });
    }
  }, [addAudioTrack, addMediaOnly, pushToast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Music className="h-4 w-4 text-primary" />
            Music tracks
          </DialogTitle>
          <DialogDescription>
            Layer music and sound effects under the main voice. Mixed at export — ducking pushes the
            music ~12 dB below voice automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {tracks.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-secondary/40 px-3 py-6 text-center text-xs text-muted-foreground">
              No music tracks yet. Add a music bed and Scribe will mix it under the spoken edit
              when you export.
            </div>
          )}
          {tracks.map((t) => (
            <TrackRow
              key={t.id}
              track={t}
              mediaPath={project.media[t.mediaId]?.path ?? "(missing media)"}
              onUpdate={(patch) => updateAudioTrack(t.id, patch)}
              onRemove={() => removeAudioTrack(t.id)}
            />
          ))}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={handleAdd} className="gap-2">
            <Plus className="h-4 w-4" /> Add music track
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TrackRowProps {
  track: AudioTrack;
  mediaPath: string;
  onUpdate: (patch: Partial<Omit<AudioTrack, "id" | "mediaId">>) => void;
  onRemove: () => void;
}

function TrackRow({ track, mediaPath, onUpdate, onRemove }: TrackRowProps) {
  const filename = mediaPath.split(/[\\/]/).pop() ?? mediaPath;
  return (
    <div className="rounded-md border border-border bg-secondary/30 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium" title={mediaPath}>
          {filename}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-400"
          aria-label="Remove track"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-xs">
          Gain
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={-30}
              max={6}
              step={0.5}
              value={track.gainDb}
              onChange={(e) => onUpdate({ gainDb: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="w-12 text-right tabular-nums text-muted-foreground">
              {track.gainDb.toFixed(1)} dB
            </span>
          </div>
        </label>
        <label className="grid gap-1 text-xs">
          Offset (sec)
          <input
            type="number"
            step={0.1}
            min={-600}
            max={600}
            value={track.offsetSec}
            onChange={(e) => onUpdate({ offsetSec: Number(e.target.value) })}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          />
        </label>
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={track.ducks}
          onChange={(e) => onUpdate({ ducks: e.target.checked })}
        />
        Duck under voice (sidechain compression)
      </label>
    </div>
  );
}
