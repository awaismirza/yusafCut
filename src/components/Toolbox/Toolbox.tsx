import { Button } from "@/components/ui/button";
import { wordIdsInOutputRange } from "@/lib/edl";
import { usePlayerStore } from "@/stores/playerStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { Flag, MousePointer2, RotateCcw, Scissors, Search, X, ZoomIn, ZoomOut } from "lucide-react";

interface ToolboxProps {
  onFindClick?: () => void;
}

export function Toolbox({ onFindClick }: ToolboxProps) {
  const project = useProjectStore((s) => s.project);
  const removeSilences = useProjectStore((s) => s.removeSilences);
  const pushToast = useUIStore((s) => s.pushToast);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const timelineMarkIn = usePlayerStore((s) => s.timelineMarkIn);
  const timelineMarkOut = usePlayerStore((s) => s.timelineMarkOut);
  const timelineZoom = usePlayerStore((s) => s.timelineZoom);
  const setTimelineRange = usePlayerStore((s) => s.setTimelineRange);
  const clearTimelineRange = usePlayerStore((s) => s.clearTimelineRange);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const setTimelineZoom = usePlayerStore((s) => s.setTimelineZoom);

  function setMarkIn() {
    setTimelineRange(currentTime, timelineMarkOut);
    if (timelineMarkOut !== null) {
      setSelectedWordIds(wordIdsInOutputRange(project, currentTime, timelineMarkOut));
    }
  }

  function setMarkOut() {
    setTimelineRange(timelineMarkIn, currentTime);
    if (timelineMarkIn !== null) {
      setSelectedWordIds(wordIdsInOutputRange(project, timelineMarkIn, currentTime));
    }
  }

  function clearMarkers() {
    clearTimelineRange();
    setSelectedWordIds([]);
  }

  function handleRemoveSilences() {
    const removed = removeSilences();
    if (removed === 0) {
      pushToast({
        title: "Nothing to trim",
        description: "No silences longer than 600ms found between words.",
      });
      return;
    }
    pushToast({
      title: `Trimmed ${removed} silence${removed === 1 ? "" : "s"}`,
      description: "Use ⌘Z to restore.",
    });
  }

  return (
    <aside className="editor-toolbox" aria-label="Editing tools">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="toolbox-button is-active"
        title="Select"
      >
        <MousePointer2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="toolbox-button"
        title="Find transcript"
        onClick={onFindClick}
      >
        <Search className="h-4 w-4" />
      </Button>
      <span className="toolbox-divider" />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={timelineMarkIn !== null ? "toolbox-button is-active" : "toolbox-button"}
        title="Set in marker (I)"
        onClick={setMarkIn}
      >
        <Flag className="h-4 w-4" />
        <span>I</span>
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={timelineMarkOut !== null ? "toolbox-button is-active" : "toolbox-button"}
        title="Set out marker (O)"
        onClick={setMarkOut}
      >
        <Flag className="h-4 w-4" />
        <span>O</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="toolbox-clear-button"
        title="Clear markers (X)"
        onClick={clearMarkers}
      >
        <X className="h-4 w-4" />
        Clear
      </Button>
      <span className="toolbox-divider" />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="toolbox-clear-button"
        title="Trim silences longer than 600ms between words"
        onClick={handleRemoveSilences}
        disabled={!project.segments.some((s) => s.words.length > 1)}
      >
        <Scissors className="h-4 w-4" />
        Trim silences
      </Button>
      <span className="toolbox-divider" />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="toolbox-button"
        title="Zoom out timeline"
        onClick={() => setTimelineZoom(timelineZoom / 1.5)}
        disabled={timelineZoom <= 1.01}
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="toolbox-button"
        title={`Timeline zoom ${timelineZoom.toFixed(1)}x`}
        onClick={() => setTimelineZoom(1)}
      >
        <RotateCcw className="h-4 w-4" />
        <span>{timelineZoom.toFixed(0)}x</span>
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="toolbox-button"
        title="Zoom in timeline"
        onClick={() => setTimelineZoom(timelineZoom * 1.5)}
        disabled={timelineZoom >= 31.99}
      >
        <ZoomIn className="h-4 w-4" />
      </Button>
    </aside>
  );
}
