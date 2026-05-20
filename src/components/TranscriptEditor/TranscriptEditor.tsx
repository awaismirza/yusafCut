/**
 * The primary editing surface — TipTap renders the transcript with each word as
 * a WordNode. Click → seek + play. Select → highlight. Delete → drop from EDL.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Find / Replace panel  (collapsible, ⌘F to toggle)          │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │                                                              │
 *   │   00:12  Lorem ipsum dolor sit amet…                         │
 *   │                                                              │
 *   │   00:34  Consectetur adipiscing elit…                        │
 *   │                                                              │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Paragraph timestamps render as a *separate* React-controlled column on the
 * left, NOT as injected DOM inside each <p>. That avoids the historical
 * double-injection bug where a re-render could duplicate the stamp.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { WordNode } from "./WordNode";
import { FindReplacePanel } from "./FindReplacePanel";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { computeTimeline, type Word } from "@/lib/edl";
import { formatTimecode } from "@/lib/timecode";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";

/** Threshold (ms) for a pause that forces a paragraph break. */
const PARAGRAPH_PAUSE_MS = 750;

/** Group flat word list into paragraphs, also capturing the paragraph start time. */
function paragraphize(words: Word[]): { words: Word[]; startTime: number }[] {
  if (words.length === 0) return [];
  const paragraphs: { words: Word[]; startTime: number }[] = [
    { words: [], startTime: words[0]!.start },
  ];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const current = paragraphs[paragraphs.length - 1]!;
    current.words.push(w);
    const next = words[i + 1];
    if (!next) break;
    const gap = (next.start - w.end) * 1000;
    const endsSentence = /[.?!]$/.test(w.text.trim());
    if (gap >= PARAGRAPH_PAUSE_MS || endsSentence) {
      paragraphs.push({ words: [], startTime: next.start });
    }
  }
  return paragraphs.filter((p) => p.words.length > 0);
}

/** Render seconds as a compact MM:SS stamp (no milliseconds). */
function stamp(seconds: number): string {
  return formatTimecode(seconds, { ms: false });
}

export function TranscriptEditor() {
  const project = useProjectStore((s) => s.project);
  const deleteWords = useProjectStore((s) => s.deleteWords);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [showFind, setShowFind] = useState(false);

  // Track each paragraph's vertical position so we can render the floating
  // timestamp column at exactly the same y as its <p>.
  const [paragraphTops, setParagraphTops] = useState<number[]>([]);

  // Flatten all words across segments in output order.
  const words = useMemo(
    () => project.segments.flatMap((s) => s.words),
    [project.segments],
  );
  const paragraphs = useMemo(() => paragraphize(words), [words]);

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, WordNode],
    editable: true,
    content: { type: "doc", content: [] },
    editorProps: {
      attributes: {
        class: "transcript-editor",
      },
      handleClickOn(_view, _pos, node, _nodePos, event) {
        if (node.type.name === "word") {
          const start = Number(node.attrs.start);
          // Seek video to this word's source timestamp and start playback.
          window.dispatchEvent(
            new CustomEvent("scribe:seek-source", { detail: { start } }),
          );
          // Also flip the store so the Play button icon updates.
          usePlayerStore.getState().setPlaying(true);
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleKeyDown(_view, event) {
        // ⌘F / Ctrl+F → toggle the find panel
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setShowFind((v) => !v);
          return true;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) return false;
          const range = sel.getRangeAt(0);
          const fragment = range.cloneContents();
          const wordEls = fragment.querySelectorAll<HTMLElement>("[data-word-id]");
          const ids: string[] = [];
          wordEls.forEach((el) => {
            const id = el.dataset.wordId;
            if (id) ids.push(id);
          });
          if (ids.length === 0) return false;
          deleteWords(ids);
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });

  // Global ⌘F handler (in case focus isn't in the editor yet).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowFind((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Re-render the TipTap document whenever the EDL changes.
  useEffect(() => {
    if (!editor) return;
    const cleanDoc = {
      type: "doc",
      content: paragraphs.map((para) => ({
        type: "paragraph",
        content: para.words.flatMap((w, i) => {
          const nodes: object[] = [
            {
              type: "word",
              attrs: {
                wordId: w.id,
                start: w.start,
                end: w.end,
                confidence: w.confidence,
              },
              content: [{ type: "text", text: w.text }],
            },
          ];
          if (i < para.words.length - 1) {
            nodes.push({ type: "text", text: " " });
          }
          return nodes;
        }),
      })),
    };

    editor.commands.setContent(cleanDoc as never, false);
  }, [editor, paragraphs]);

  // Measure paragraph positions so the floating timestamp column lines up.
  // Re-measures on layout changes (resize, content change).
  useLayoutEffect(() => {
    function measure() {
      const root = editorRef.current;
      if (!root) return;
      const paras = root.querySelectorAll<HTMLElement>(".transcript-editor p");
      const rootRect = root.getBoundingClientRect();
      const tops: number[] = [];
      paras.forEach((p) => {
        const r = p.getBoundingClientRect();
        tops.push(r.top - rootRect.top + root.scrollTop);
      });
      setParagraphTops(tops);
    }
    measure();
    // Re-measure shortly after — TipTap's setContent renders async.
    const t = setTimeout(measure, 50);
    const ro = new ResizeObserver(measure);
    if (editorRef.current) ro.observe(editorRef.current);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [paragraphs, editor]);

  // Sync word selection → store
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      const { from, to } = editor.state.selection;
      const ids: string[] = [];
      editor.state.doc.nodesBetween(from, to, (node) => {
        if (node.type.name === "word") ids.push(node.attrs.wordId as string);
        return true;
      });
      setSelectedWordIds(ids);
    };
    editor.on("selectionUpdate", handler);
    return () => { editor.off("selectionUpdate", handler); };
  }, [editor, setSelectedWordIds]);

  // Highlight the currently playing word.
  const currentTime = usePlayerStore((s) => s.currentTime);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const timeline = computeTimeline(project);
    let activeWordId: string | null = null;
    for (const entry of timeline) {
      if (currentTime >= entry.outputStart && currentTime < entry.outputEnd) {
        const sourceTime = entry.sourceIn + (currentTime - entry.outputStart);
        const seg = project.segments.find((s) => s.id === entry.segmentId);
        if (seg) {
          for (const w of seg.words) {
            if (sourceTime >= w.start && sourceTime < w.end) {
              activeWordId = w.id;
              break;
            }
          }
        }
        break;
      }
    }
    root.querySelectorAll<HTMLElement>(".word.is-playing").forEach((el) =>
      el.classList.remove("is-playing"),
    );
    if (activeWordId) {
      const el = root.querySelector<HTMLElement>(
        `[data-word-id="${CSS.escape(activeWordId)}"]`,
      );
      if (el) {
        el.classList.add("is-playing");
        const rect = el.getBoundingClientRect();
        const cRect = root.getBoundingClientRect();
        if (rect.bottom > cRect.bottom || rect.top < cRect.top) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }, [currentTime, project]);

  // Click on a paragraph timestamp → seek to start of that paragraph.
  const seekToParagraph = useCallback((startTime: number) => {
    window.dispatchEvent(
      new CustomEvent("scribe:seek-source", { detail: { start: startTime } }),
    );
    usePlayerStore.getState().setPlaying(true);
  }, []);

  // ── Empty / loading states ────────────────────────────────────────────────

  // All words deleted after transcription
  if (project.segments.length > 0 && words.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center text-muted-foreground">
        <div>
          <p className="text-sm font-medium">All words deleted</p>
          <p className="mt-1 text-xs opacity-60">Press ⌘Z to undo</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col">
      {showFind && <FindReplacePanel onClose={() => setShowFind(false)} />}
      {!showFind && (
        // Floating Find button — top-right of the editor area
        <Button
          size="icon"
          variant="ghost"
          className="absolute right-3 top-14 z-10 h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => setShowFind(true)}
          title="Find & Replace (⌘F)"
        >
          <Search className="h-4 w-4" />
        </Button>
      )}

      <div className="transcript-scroll relative flex-1">
        <div ref={editorRef} className="relative">
          {/* Floating timestamp column — one chip per paragraph, lined up. */}
          <div className="pointer-events-none absolute left-0 top-0 z-[1] hidden md:block">
            {paragraphs.map((para, idx) => {
              const top = paragraphTops[idx];
              if (top === undefined) return null;
              return (
                <button
                  key={`${para.startTime}-${idx}`}
                  type="button"
                  onClick={() => seekToParagraph(para.startTime)}
                  className="paragraph-ts-chip pointer-events-auto"
                  style={{ top }}
                  title="Jump to this paragraph"
                >
                  {stamp(para.startTime)}
                </button>
              );
            })}
          </div>

          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
