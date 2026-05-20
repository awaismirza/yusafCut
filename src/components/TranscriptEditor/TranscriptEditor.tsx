/**
 * The primary editing surface — TipTap renders the transcript with each word as
 * a WordNode. Click → seek + play. Select → highlight. Delete → drop from EDL.
 *
 * Each paragraph shows a small non-editable timestamp badge before the first word
 * so the editor looks and feels like a professional transcript.
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
import { formatDuration } from "@/lib/timecode";

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

export function TranscriptEditor() {
  const project = useProjectStore((s) => s.project);
  const deleteWords = useProjectStore((s) => s.deleteWords);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

    // Inject timestamp labels via DOM after TipTap renders.
    // This avoids fighting the ProseMirror document model.
    requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      // Remove old stamps
      root.querySelectorAll(".paragraph-ts").forEach((el) => el.remove());
      // Add fresh ones
      const paras = root.querySelectorAll<HTMLElement>(".transcript-editor p");
      paras.forEach((p, idx) => {
        const para = paragraphs[idx];
        if (!para) return;
        const stamp = document.createElement("span");
        stamp.className = "paragraph-ts";
        stamp.contentEditable = "false";
        stamp.textContent = formatDuration(para.startTime);
        p.insertBefore(stamp, p.firstChild);
      });
    });
  }, [editor, paragraphs]);

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
    <div ref={containerRef} className="transcript-scroll h-full">
      <EditorContent editor={editor} />
    </div>
  );
}
