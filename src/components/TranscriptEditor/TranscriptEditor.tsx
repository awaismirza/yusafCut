/**
 * The primary editing surface — TipTap renders the transcript with each word as
 * a `WordNode`. Click → seek. Select → highlight. Delete → drop from the EDL.
 *
 * Render strategy: regenerate the TipTap document whenever the EDL segments
 * change. For an interactive editor this would be too coarse, but for the MVP
 * the document is small (a few thousand words at most) so we re-render lazily.
 */

import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { WordNode } from "./WordNode";
import { useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { computeTimeline, type Word } from "@/lib/edl";

/** Threshold for sentence-end / pause-driven paragraph breaks. Per spec: 750 ms. */
const PARAGRAPH_PAUSE_MS = 750;

/** Group words into paragraphs by pauses and sentence-end punctuation. */
function paragraphize(words: Word[]): Word[][] {
  if (words.length === 0) return [];
  const paragraphs: Word[][] = [[]];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    paragraphs[paragraphs.length - 1]!.push(w);
    const next = words[i + 1];
    if (!next) break;
    const gap = (next.start - w.end) * 1000;
    const endsSentence = /[.?!]$/.test(w.text);
    if (gap >= PARAGRAPH_PAUSE_MS || endsSentence) {
      paragraphs.push([]);
    }
  }
  return paragraphs.filter((p) => p.length > 0);
}

export function TranscriptEditor() {
  const project = useProjectStore((s) => s.project);
  const deleteWords = useProjectStore((s) => s.deleteWords);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Flatten EDL segments → words in output order
  const words = useMemo(() => project.segments.flatMap((s) => s.words), [project.segments]);
  const paragraphs = useMemo(() => paragraphize(words), [words]);

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, WordNode],
    editable: true,
    content: { type: "doc", content: [] },
    editorProps: {
      attributes: {
        class: "transcript-editor outline-none px-6 py-4 min-h-full prose prose-sm dark:prose-invert max-w-none",
      },
      handleClickOn(_view, _pos, node, _nodePos, event) {
        if (node.type.name === "word") {
          const start = Number(node.attrs.start);
          // Update playback to source-time of the clicked word
          window.dispatchEvent(new CustomEvent("scribe:seek-source", { detail: { start, mediaId: undefined } }));
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleKeyDown(_view, event) {
        if (event.key === "Backspace" || event.key === "Delete") {
          // Collect selected word ids and pass to the store
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

  // Re-render document whenever the EDL changes
  useEffect(() => {
    if (!editor) return;
    const doc = {
      type: "doc",
      content: paragraphs.map((para) => ({
        type: "paragraph",
        content: para.flatMap((w, i) => {
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
          // Insert a space between words inside a paragraph
          if (i < para.length - 1) {
            nodes.push({ type: "text", text: " " });
          }
          return nodes;
        }),
      })),
    };
    editor.commands.setContent(doc as never, false);
  }, [editor, paragraphs]);

  // Sync selection from editor → store
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      const { from, to } = editor.state.selection;
      const ids: string[] = [];
      editor.state.doc.nodesBetween(from, to, (node) => {
        if (node.type.name === "word") {
          ids.push(node.attrs.wordId as string);
        }
        return true;
      });
      setSelectedWordIds(ids);
    };
    editor.on("selectionUpdate", handler);
    return () => {
      editor.off("selectionUpdate", handler);
    };
  }, [editor, setSelectedWordIds]);

  // Highlight the currently playing word
  const currentTime = usePlayerStore((s) => s.currentTime);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    // Find word whose source-time bracket includes the current OUTPUT time, mapped back.
    // We re-derive output→source via the timeline.
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
    root.querySelectorAll<HTMLElement>(".word.is-playing").forEach((el) => {
      el.classList.remove("is-playing");
    });
    if (activeWordId) {
      const el = root.querySelector<HTMLElement>(`[data-word-id="${CSS.escape(activeWordId)}"]`);
      if (el) {
        el.classList.add("is-playing");
        // Scroll into view if it has drifted off-screen
        const rect = el.getBoundingClientRect();
        const containerRect = root.getBoundingClientRect();
        if (rect.bottom > containerRect.bottom || rect.top < containerRect.top) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }, [currentTime, project]);

  if (project.segments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
        <div>
          <div className="mb-2 text-base">No transcript yet.</div>
          <div className="text-xs">
            Open or drag in a video file to get started. Use the Transcribe button in the toolbar.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto">
      <EditorContent editor={editor} />
    </div>
  );
}
