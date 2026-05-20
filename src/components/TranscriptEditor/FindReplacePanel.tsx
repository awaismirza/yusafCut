/**
 * Find / Replace panel + one-click filler-word removal.
 *
 * Lives above the transcript editor. Operates on the EDL directly via the
 * project store — every replacement is a normal mutation so undo/redo works.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { ChevronDown, ChevronUp, Eraser, Replace, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Default list of "filler" words a transcript editor typically wants removed. */
export const DEFAULT_FILLERS = [
  "um",
  "uh",
  "umm",
  "uhh",
  "er",
  "erm",
  "ah",
  "ahh",
  "hmm",
  "mhm",
  "mm",
  "like",
  "basically",
  "literally",
  "actually",
  "honestly",
  "right",
  "okay",
  "ok",
  "so",
] as const;

interface FindReplacePanelProps {
  /** Hide the panel. The parent owns visibility state. */
  onClose: () => void;
}

export function FindReplacePanel({ onClose }: FindReplacePanelProps) {
  const replaceText = useProjectStore((s) => s.replaceText);
  const deleteWordsByText = useProjectStore((s) => s.deleteWordsByText);
  const paddingMs = useProjectStore((s) => s.project.settings.paddingMs);
  const updatePaddingMs = useProjectStore((s) => s.updatePaddingMs);
  const pushToast = useUIStore((s) => s.pushToast);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(true);
  const [matchIndex, setMatchIndex] = useState(0);
  const [showFillerMenu, setShowFillerMenu] = useState(false);
  const [selectedFillers, setSelectedFillers] = useState<Set<string>>(
    new Set(["um", "uh", "umm", "uhh", "er", "erm", "ah", "hmm"]),
  );

  const findInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the find input when the panel opens; allow Esc to close.
  useEffect(() => {
    findInputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Highlight matches in the editor whenever the search term changes.
  useEffect(() => {
    const root = document.querySelector(".transcript-editor");
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".word.is-match").forEach((el) => {
      el.classList.remove("is-match", "is-current-match");
    });
    if (!find) return;
    const needle = caseSensitive ? find : find.toLowerCase();
    const wordEls = root.querySelectorAll<HTMLElement>(".word");
    const matches: HTMLElement[] = [];
    wordEls.forEach((el) => {
      const text = el.textContent ?? "";
      const haystack = caseSensitive ? text : text.toLowerCase();
      const isMatch = wholeWord
        ? haystack.replace(/^[\s.,!?;:"'()[\]{}—–-]+|[\s.,!?;:"'()[\]{}—–-]+$/g, "") === needle
        : haystack.includes(needle);
      if (isMatch) {
        el.classList.add("is-match");
        matches.push(el);
      }
    });
    if (matches.length > 0) {
      const idx = matchIndex % matches.length;
      matches[idx]!.classList.add("is-current-match");
      matches[idx]!.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return () => {
      root
        .querySelectorAll<HTMLElement>(".word.is-match")
        .forEach((el) => el.classList.remove("is-match", "is-current-match"));
    };
  }, [find, caseSensitive, wholeWord, matchIndex]);

  const matchCount = useMemo(() => {
    if (!find) return 0;
    const root = document.querySelector(".transcript-editor");
    if (!root) return 0;
    const needle = caseSensitive ? find : find.toLowerCase();
    let count = 0;
    root.querySelectorAll<HTMLElement>(".word").forEach((el) => {
      const text = el.textContent ?? "";
      const haystack = caseSensitive ? text : text.toLowerCase();
      const m = wholeWord
        ? haystack.replace(/^[\s.,!?;:"'()[\]{}—–-]+|[\s.,!?;:"'()[\]{}—–-]+$/g, "") === needle
        : haystack.includes(needle);
      if (m) count++;
    });
    return count;
  }, [find, caseSensitive, wholeWord]);

  function step(delta: number) {
    if (matchCount === 0) return;
    setMatchIndex((i) => (i + delta + matchCount) % matchCount);
  }

  function handleReplaceAll() {
    if (!find) return;
    const n = replaceText(find, replace, { caseSensitive, wholeWord });
    if (n === 0) {
      pushToast({ title: "No matches found" });
    } else {
      pushToast({ title: `Replaced ${n} ${n === 1 ? "word" : "words"}` });
    }
  }

  function handleRemoveFind() {
    if (!find) return;
    const n = deleteWordsByText(new Set([find.toLowerCase().trim()]));
    if (n === 0) {
      pushToast({ title: "No matches found" });
    } else {
      pushToast({
        title: `Removed ${n} ${n === 1 ? "word" : "words"}`,
        description:
          paddingMs > 0 ? `Kept ${(paddingMs / 1000).toFixed(1)}s around each cut` : undefined,
      });
    }
  }

  function handleRemoveFillers() {
    const n = deleteWordsByText(selectedFillers);
    if (n === 0) {
      pushToast({ title: "No filler words found" });
    } else {
      pushToast({
        title: `Removed ${n} filler ${n === 1 ? "word" : "words"}`,
        description:
          paddingMs > 0
            ? `Kept ${(paddingMs / 1000).toFixed(1)}s around each cut`
            : "Press ⌘Z to undo",
      });
    }
    setShowFillerMenu(false);
  }

  function toggleFiller(token: string) {
    setSelectedFillers((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  return (
    <div className="relative z-10 flex flex-col gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
      {/* ── Row 1: search + nav ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={findInputRef}
          type="text"
          value={find}
          placeholder="Find in transcript"
          onChange={(e) => {
            setFind(e.target.value);
            setMatchIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          }}
          className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="w-16 select-none text-right text-xs tabular-nums text-muted-foreground">
          {find
            ? matchCount === 0
              ? "0 / 0"
              : `${(matchIndex % matchCount) + 1} / ${matchCount}`
            : ""}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => step(-1)}
          disabled={matchCount === 0}
          title="Previous (Shift+Enter)"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => step(1)}
          disabled={matchCount === 0}
          title="Next (Enter)"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Row 2: replace + filler removal ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Replace className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={replace}
          placeholder="Replace with…"
          onChange={(e) => setReplace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleReplaceAll();
          }}
          className="h-7 flex-1 min-w-[160px] rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={handleReplaceAll}
          disabled={!find}
        >
          Replace all
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={handleRemoveFind}
          disabled={!find}
          title="Delete every occurrence of the search term"
        >
          Delete matches
        </Button>

        <div className="relative ml-auto">
          <Button
            size="sm"
            variant="default"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setShowFillerMenu((v) => !v)}
          >
            <Eraser className="h-3.5 w-3.5" />
            Remove filler words
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", showFillerMenu && "rotate-180")}
            />
          </Button>
          {showFillerMenu && (
            <div className="absolute right-0 top-9 z-20 w-72 rounded-md border border-border bg-popover p-3 shadow-lg">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Select fillers to remove
              </div>
              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_FILLERS.map((token) => {
                  const on = selectedFillers.has(token);
                  return (
                    <button
                      key={token}
                      type="button"
                      onClick={() => toggleFiller(token)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs transition-colors",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-foreground hover:bg-accent",
                      )}
                    >
                      {token}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setShowFillerMenu(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 text-xs"
                  onClick={handleRemoveFillers}
                  disabled={selectedFillers.size === 0}
                >
                  Remove {selectedFillers.size}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Options */}
        <label className="flex select-none items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          Aa
        </label>
        <label
          className="flex select-none items-center gap-1 text-xs text-muted-foreground"
          title="Whole word"
        >
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          W
        </label>
        <label
          className="ml-auto flex min-w-[240px] items-center gap-2 text-xs text-muted-foreground"
          title="Audio kept around deleted words"
        >
          Gap
          <input
            className="min-w-0 flex-1"
            type="range"
            min={0}
            max={10_000}
            step={250}
            value={paddingMs}
            onChange={(e) => updatePaddingMs(Number(e.target.value))}
          />
          <span className="w-12 text-right tabular-nums">{(paddingMs / 1000).toFixed(1)}s</span>
        </label>
      </div>
    </div>
  );
}
