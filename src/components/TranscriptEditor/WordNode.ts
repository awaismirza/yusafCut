/**
 * Custom TipTap inline node that represents a single transcribed word with
 * its source-time metadata. Each word renders as a <span class="word" data-…>
 * so the playback highlighter can target it without re-walking the document.
 */

import { Node, mergeAttributes } from "@tiptap/core";

export interface WordAttrs {
  wordId: string;
  start: number;
  end: number;
  confidence: number;
  deleted?: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    word: {
      insertWord: (attrs: WordAttrs, text: string) => ReturnType;
    };
  }
}

export const WordNode = Node.create({
  name: "word",
  inline: true,
  group: "inline",
  selectable: true,
  atom: false,
  content: "text*",

  addAttributes() {
    return {
      wordId: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-word-id") ?? "",
        renderHTML: (attrs) => ({ "data-word-id": attrs.wordId as string }),
      },
      start: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute("data-start") ?? 0),
        renderHTML: (attrs) => ({ "data-start": String(attrs.start) }),
      },
      end: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute("data-end") ?? 0),
        renderHTML: (attrs) => ({ "data-end": String(attrs.end) }),
      },
      confidence: {
        default: 1,
        parseHTML: (el) => Number(el.getAttribute("data-confidence") ?? 1),
        renderHTML: (attrs) => ({ "data-confidence": String(attrs.confidence) }),
      },
      deleted: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-deleted") === "true",
        renderHTML: (attrs) =>
          attrs.deleted ? { "data-deleted": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span.word" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const confidence = node.attrs.confidence as number;
    const deleted = node.attrs.deleted as boolean;
    const classes = ["word"];
    if (deleted) classes.push("is-deleted");
    if (confidence < 0.6) classes.push("low-confidence");
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: classes.join(" ") }),
      0,
    ];
  },

  addCommands() {
    return {
      insertWord:
        (attrs, text) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
            content: [{ type: "text", text }],
          }),
    };
  },
});
