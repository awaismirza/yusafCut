import { Button } from "@/components/ui/button";
import { computeTimeline, projectChapters, wordIdsInOutputRange } from "@/lib/edl";
import { detectChapters, suggestBroll, type BrollSuggestion } from "@/lib/ipc";
import { usePlayerStore } from "@/stores/playerStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import {
  Bookmark,
  Clapperboard,
  Flag,
  Loader2,
  MousePointer2,
  RotateCcw,
  Scissors,
  Search,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useState } from "react";

interface ToolboxProps {
  onFindClick?: () => void;
}

export function Toolbox({ onFindClick }: ToolboxProps) {
  const project = useProjectStore((s) => s.project);
  const removeSilences = useProjectStore((s) => s.removeSilences);
  const addChapter = useProjectStore((s) => s.addChapter);
  const setChapters = useProjectStore((s) => s.setChapters);
  const pushToast = useUIStore((s) => s.pushToast);
  const setEditOperationLabel = useUIStore((s) => s.setEditOperationLabel);
  const [detectingChapters, setDetectingChapters] = useState(false);
  const [suggestingBroll, setSuggestingBroll] = useState(false);
  const [brollSuggestions, setBrollSuggestions] = useState<BrollSuggestion[]>([]);
  const chapterCount = projectChapters(project).length;
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
    // Show the loader immediately so the user sees feedback while the main
    // thread is busy applying the silence-removal edit. We defer the actual
    // work by one rAF so React has time to paint the dialog first.
    setEditOperationLabel("Trimming silences…");
    requestAnimationFrame(() => {
      // A second rAF ensures the browser has committed the paint.
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

  function handleAddChapter() {
    // Prompts feel out of place in a pro NLE but we'll deliver the lightweight
    // version here; a proper inline chapter list is on the roadmap.
    const defaultTitle = `Chapter ${chapterCount + 1}`;
    const title = window.prompt("Chapter title", defaultTitle) ?? defaultTitle;
    if (title === null) return;
    addChapter(currentTime, title);
    pushToast({
      title: "Chapter added",
      description: `${title} at ${currentTime.toFixed(2)}s`,
    });
  }

  async function handleDetectChapters() {
    if (detectingChapters) return;

    // Build a timestamped transcript from the output timeline so the LLM
    // sees output-time positions and its returned startSeconds values map
    // directly to Chapter.outputTime with no further conversion.
    const timeline = computeTimeline(project);
    const lines: string[] = [];
    for (const entry of timeline) {
      const seg = project.segments.find((s) => s.id === entry.segmentId);
      if (!seg) continue;
      for (const word of seg.words) {
        if (word.start >= entry.sourceIn && word.start < entry.sourceOut) {
          const outputT = entry.outputStart + (word.start - entry.sourceIn);
          lines.push(`[${outputT.toFixed(1)}] ${word.text}`);
        }
      }
    }
    const transcript = lines.join(" ");

    if (transcript.trim().length < 20) {
      pushToast({
        title: "No transcript yet",
        description: "Transcribe the clip first so the AI has text to work from.",
      });
      return;
    }

    // Use the first media ID as the job label (most projects have one clip).
    const mediaId = project.segments[0]?.mediaId ?? project.id;

    setDetectingChapters(true);
    pushToast({
      title: "Detecting chapters…",
      description: "Running on-device AI — this may take 15–30 s on first run.",
    });

    try {
      const markers = await detectChapters({ mediaId, transcript, nChapters: 10 });
      setChapters(markers.map((m) => ({ title: m.title, outputTime: m.startSeconds })));
      pushToast({
        title: `${markers.length} chapter${markers.length === 1 ? "" : "s"} detected`,
        description: "Draft chapters added — click any to jump, or edit inline.",
      });
    } catch (err) {
      pushToast({
        title: "Chapter detection failed",
        description: String(err),
      });
    } finally {
      setDetectingChapters(false);
    }
  }

  async function handleSuggestBroll() {
    if (suggestingBroll) return;

    // Build a timestamped transcript for the visible timeline range (or full project).
    const timeline = computeTimeline(project);
    const rangeStart = 0;
    const rangeEnd = timeline.reduce((acc, e) => Math.max(acc, e.outputEnd), 0);

    const lines: string[] = [];
    for (const entry of timeline) {
      const seg = project.segments.find((s) => s.id === entry.segmentId);
      if (!seg) continue;
      for (const word of seg.words) {
        if (word.start >= entry.sourceIn && word.start < entry.sourceOut) {
          const outputT = entry.outputStart + (word.start - entry.sourceIn);
          lines.push(`[${outputT.toFixed(1)}] ${word.text}`);
        }
      }
    }
    const transcript = lines.join(" ");

    if (transcript.trim().length < 20) {
      pushToast({
        title: "No transcript yet",
        description: "Transcribe the clip first so the AI has text to work from.",
      });
      return;
    }

    const mediaId = project.segments[0]?.mediaId ?? project.id;

    setSuggestingBroll(true);
    setBrollSuggestions([]);
    pushToast({
      title: "Generating b-roll ideas…",
      description: "On-device AI — first run loads the model (~15 s).",
    });

    try {
      const suggestions = await suggestBroll({
        mediaId,
        transcript,
        startSeconds: rangeStart,
        endSeconds: rangeEnd,
        nSuggestions: 5,
      });
      setBrollSuggestions(suggestions);
      pushToast({
        title: `${suggestions.length} b-roll idea${suggestions.length === 1 ? "" : "s"}`,
        description: "Suggestions shown below the timeline. Click to copy query.",
      });
    } catch (err) {
      pushToast({
        title: "B-roll suggestion failed",
        description: String(err),
      });
    } finally {
      setSuggestingBroll(false);
    }
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
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="toolbox-clear-button"
        title="Add chapter at playhead (B)"
        onClick={handleAddChapter}
        disabled={project.segments.length === 0}
      >
        <Bookmark className="h-4 w-4" />
        {chapterCount > 0 ? `Chapter (${chapterCount})` : "Chapter"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="toolbox-clear-button"
        title="Detect chapters with on-device AI (Llama 3B · MLX)"
        onClick={handleDetectChapters}
        disabled={project.segments.length === 0 || detectingChapters}
      >
        {detectingChapters ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {detectingChapters ? "Detecting…" : "AI chapters"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="toolbox-clear-button"
        title="Suggest b-roll shots with on-device AI (Llama 3B · MLX)"
        onClick={handleSuggestBroll}
        disabled={project.segments.length === 0 || suggestingBroll}
      >
        {suggestingBroll ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Clapperboard className="h-4 w-4" />
        )}
        {suggestingBroll ? "Thinking…" : "B-roll"}
      </Button>

      {/* B-roll suggestion chips — shown below buttons when results are ready */}
      {brollSuggestions.length > 0 && (
        <>
          <span className="toolbox-divider" />
          <div className="flex flex-col gap-1 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              B-roll ideas
            </span>
            {brollSuggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                title={`${s.rationale}\nClick to copy search query`}
                className="rounded bg-accent px-2 py-1 text-left text-xs hover:bg-accent/80"
                onClick={() => {
                  void navigator.clipboard.writeText(s.query);
                  pushToast({ title: "Copied", description: s.query });
                }}
              >
                <span className="text-muted-foreground">
                  {s.startSeconds.toFixed(0)}s–{s.endSeconds.toFixed(0)}s
                </span>{" "}
                {s.query}
              </button>
            ))}
            <button
              type="button"
              className="mt-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setBrollSuggestions([])}
            >
              Clear
            </button>
          </div>
        </>
      )}

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
