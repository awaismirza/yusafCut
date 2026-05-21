import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { projectChapters, wordIdsInOutputRange } from "@/lib/edl";
import { usePlayerStore } from "@/stores/playerStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import {
  Bookmark,
  ChevronDown,
  Flag,
  MessageSquareOff,
  MousePointer2,
  RotateCcw,
  Scissors,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

/** Common English filler words to remove in one click. */
const FILLER_TOKENS = new Set([
  "um", "uh", "umm", "uhh", "hmm", "hm", "er", "err",
  "like", "literally", "basically", "actually", "you know",
  "i mean", "i guess", "sort of", "kind of", "you see",
  "right", "okay", "ok", "so", "well", "anyway",
]);

interface ToolboxProps {
  onFindClick?: () => void;
}

export function Toolbox({ onFindClick }: ToolboxProps) {
  const project = useProjectStore((s) => s.project);
  const removeSilences = useProjectStore((s) => s.removeSilences);
  const deleteWordsByText = useProjectStore((s) => s.deleteWordsByText);
  const addChapter = useProjectStore((s) => s.addChapter);
  const pushToast = useUIStore((s) => s.pushToast);
  const setEditOperationLabel = useUIStore((s) => s.setEditOperationLabel);
  const chapterCount = projectChapters(project).length;
  const currentTime = usePlayerStore((s) => s.currentTime);
  const timelineMarkIn = usePlayerStore((s) => s.timelineMarkIn);
  const timelineMarkOut = usePlayerStore((s) => s.timelineMarkOut);
  const timelineZoom = usePlayerStore((s) => s.timelineZoom);
  const setTimelineRange = usePlayerStore((s) => s.setTimelineRange);
  const clearTimelineRange = usePlayerStore((s) => s.clearTimelineRange);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const setTimelineZoom = usePlayerStore((s) => s.setTimelineZoom);

  const hasWords = project.segments.some((s) => s.words.length > 0);
  const hasMultipleWords = project.segments.some((s) => s.words.length > 1);
  const hasMarkers = timelineMarkIn !== null || timelineMarkOut !== null;

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
    setEditOperationLabel("Trimming silences…");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          const removed = removeSilences();
          if (removed === 0) {
            pushToast({
              title: "Nothing to trim",
              description: "No silences longer than 600ms found between words.",
            });
          } else {
            pushToast({
              title: `Trimmed ${removed} silence${removed === 1 ? "" : "s"}`,
              description: "Use ⌘Z to restore.",
            });
          }
        } finally {
          setEditOperationLabel(null);
        }
      });
    });
  }

  function handleRemoveFillers() {
    setEditOperationLabel("Removing filler words…");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          const removed = deleteWordsByText(FILLER_TOKENS);
          if (removed === 0) {
            pushToast({
              title: "No filler words found",
              description: "None of the common filler words (um, uh, like…) appear in the transcript.",
            });
          } else {
            pushToast({
              title: `Removed ${removed} filler word${removed === 1 ? "" : "s"}`,
              description: "Matching audio ranges are cut from the timeline. Use ⌘Z to restore.",
            });
          }
        } finally {
          setEditOperationLabel(null);
        }
      });
    });
  }

  function handleAddChapter() {
    const defaultTitle = `Chapter ${chapterCount + 1}`;
    const title = window.prompt("Chapter title", defaultTitle) ?? defaultTitle;
    if (title === null) return;
    addChapter(currentTime, title);
    pushToast({
      title: "Chapter added",
      description: `${title} at ${currentTime.toFixed(2)}s`,
    });
  }

  return (
    <div className="tool-group" aria-label="Editing tools">
      {/* Select — always visible */}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="tool-button tool-button-active"
        title="Select tool"
      >
        <MousePointer2 className="h-4 w-4" />
      </Button>

      {/* Find — always visible */}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="tool-button"
        title="Find in transcript"
        onClick={onFindClick}
      >
        <Search className="h-4 w-4" />
      </Button>

      {/* Markers ▾ */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className={hasMarkers ? "tool-button tool-button-active" : "tool-button"}
            title="Timeline markers"
          >
            <Flag className="h-4 w-4" />
            Markers <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          <DropdownMenuItem onClick={setMarkIn}>
            <Flag className="h-4 w-4 mr-2" />
            Set In point
            <span className="ml-auto text-xs text-muted-foreground pl-4">I</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={setMarkOut}>
            <Flag className="h-4 w-4 mr-2" />
            Set Out point
            <span className="ml-auto text-xs text-muted-foreground pl-4">O</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={clearMarkers} disabled={!hasMarkers}>
            <X className="h-4 w-4 mr-2" />
            Clear markers
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit ▾ */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="tool-button" title="Edit operations">
            <Scissors className="h-4 w-4" />
            Edit <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          <DropdownMenuItem onClick={handleRemoveSilences} disabled={!hasMultipleWords}>
            <Scissors className="h-4 w-4 mr-2" />
            Trim silences
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleRemoveFillers} disabled={!hasWords}>
            <MessageSquareOff className="h-4 w-4 mr-2" />
            Remove fillers
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleAddChapter}
            disabled={project.segments.length === 0}
          >
            <Bookmark className="h-4 w-4 mr-2" />
            {chapterCount > 0 ? `Add chapter (${chapterCount})` : "Add chapter"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Zoom controls — three compact icon buttons */}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="tool-button"
        title="Zoom out timeline"
        onClick={() => setTimelineZoom(timelineZoom / 1.5)}
        disabled={timelineZoom <= 1.01}
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="tool-button"
        title={`Zoom ${timelineZoom.toFixed(1)}× — click to reset`}
        onClick={() => setTimelineZoom(1)}
      >
        <RotateCcw className="h-3 w-3" />
        <span className="text-xs tabular-nums">{timelineZoom.toFixed(0)}×</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="tool-button"
        title="Zoom in timeline"
        onClick={() => setTimelineZoom(timelineZoom * 1.5)}
        disabled={timelineZoom >= 31.99}
      >
        <ZoomIn className="h-4 w-4" />
      </Button>
    </div>
  );
}
