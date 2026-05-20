import { describe, it, expect } from "vitest";
import {
  addMediaWithTranscript,
  computeTimeline,
  deleteWords,
  findWord,
  findWordAtSourceTime,
  newProject,
  nextSurvivingSegment,
  outputTimeToSource,
  removeSilences,
  sourceTimeToOutput,
  splitSegmentAtWord,
  totalDuration,
  wordIdToOutputTime,
  wordIdsInOutputRange,
  type SourceMedia,
  type Word,
} from "@/lib/edl";

function makeMedia(overrides: Partial<SourceMedia> = {}): SourceMedia {
  return {
    id: "media-1",
    path: "/tmp/test.mp4",
    duration: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    sha256: "deadbeef",
    ...overrides,
  };
}

function makeWords(spec: Array<[string, number, number]>): Word[] {
  return spec.map(([text, start, end], i) => ({
    id: `w-${i}`,
    text,
    start,
    end,
    confidence: 0.95,
  }));
}

describe("EDL — pure functions", () => {
  describe("newProject", () => {
    it("creates a v1 project with default settings", () => {
      const p = newProject("Untitled");
      expect(p.version).toBe(1);
      expect(p.name).toBe("Untitled");
      expect(p.segments).toEqual([]);
      expect(p.media).toEqual({});
      expect(p.settings.exportPreset).toBe("youtube-1080p");
      expect(p.settings.paddingMs).toBe(80);
    });
  });

  describe("addMediaWithTranscript", () => {
    it("adds media and a single segment spanning the entire duration", () => {
      const project = newProject("test");
      const media = makeMedia({ duration: 5 });
      const words = makeWords([
        ["hello", 0, 0.5],
        ["world", 0.6, 1.1],
      ]);
      const next = addMediaWithTranscript(project, media, words);
      expect(Object.keys(next.media)).toEqual(["media-1"]);
      expect(next.segments).toHaveLength(1);
      expect(next.segments[0]!.sourceIn).toBe(0);
      expect(next.segments[0]!.sourceOut).toBe(5);
      expect(next.segments[0]!.words).toEqual(words);
    });

    it("does not mutate the input project", () => {
      const project = newProject("test");
      const before = JSON.stringify(project);
      addMediaWithTranscript(project, makeMedia(), makeWords([["x", 0, 1]]));
      expect(JSON.stringify(project)).toBe(before);
    });
  });

  describe("computeTimeline", () => {
    it("concatenates segments to produce monotonic output times", () => {
      let p = newProject("t");
      const m = makeMedia({ duration: 10 });
      p = addMediaWithTranscript(p, m, []);
      // Manually wedge in a second segment to test concat
      p = {
        ...p,
        segments: [
          { id: "s1", mediaId: "media-1", words: [], sourceIn: 0, sourceOut: 3 },
          { id: "s2", mediaId: "media-1", words: [], sourceIn: 5, sourceOut: 7 },
        ],
      };
      const tl = computeTimeline(p);
      expect(tl).toEqual([
        { segmentId: "s1", mediaId: "media-1", sourceIn: 0, sourceOut: 3, outputStart: 0, outputEnd: 3 },
        { segmentId: "s2", mediaId: "media-1", sourceIn: 5, sourceOut: 7, outputStart: 3, outputEnd: 5 },
      ]);
    });
  });

  describe("totalDuration", () => {
    it("sums segment lengths in source-time", () => {
      const p = newProject("t");
      p.segments = [
        { id: "a", mediaId: "m", words: [], sourceIn: 0, sourceOut: 2.5 },
        { id: "b", mediaId: "m", words: [], sourceIn: 10, sourceOut: 11 },
      ];
      expect(totalDuration(p)).toBeCloseTo(3.5);
    });

    it("handles empty project", () => {
      expect(totalDuration(newProject("t"))).toBe(0);
    });
  });

  describe("outputTimeToSource", () => {
    it("maps output time → source time across cuts", () => {
      const p = newProject("t");
      p.segments = [
        { id: "a", mediaId: "m", words: [], sourceIn: 0, sourceOut: 2 },
        { id: "b", mediaId: "m", words: [], sourceIn: 5, sourceOut: 7 },
      ];
      // Output 0s = source 0s
      expect(outputTimeToSource(p, 0)?.sourceTime).toBe(0);
      // Output 1s = source 1s
      expect(outputTimeToSource(p, 1)?.sourceTime).toBe(1);
      // Output 2s falls at boundary → second segment, source 5s
      expect(outputTimeToSource(p, 2)?.sourceTime).toBe(5);
      // Output 3s = source 6s in second segment
      expect(outputTimeToSource(p, 3)?.sourceTime).toBe(6);
      // Past the end
      expect(outputTimeToSource(p, 99)).toBeNull();
    });
  });

  describe("sourceTimeToOutput", () => {
    it("maps surviving source time back to output time", () => {
      const p = newProject("t");
      p.segments = [
        { id: "a", mediaId: "m", words: [], sourceIn: 0, sourceOut: 2 },
        { id: "b", mediaId: "m", words: [], sourceIn: 5, sourceOut: 7 },
      ];
      expect(sourceTimeToOutput(p, "m", 1)?.outputTime).toBe(1);
      expect(sourceTimeToOutput(p, "m", 6)?.outputTime).toBe(3);
      expect(sourceTimeToOutput(p, "m", 4)).toBeNull();
    });
  });

  describe("wordIdToOutputTime", () => {
    it("uses output order when locating a selected word", () => {
      const p = newProject("t");
      p.segments = [
        {
          id: "a",
          mediaId: "m",
          words: [{ id: "w-a", text: "a", start: 0.25, end: 0.5, confidence: 1 }],
          sourceIn: 0,
          sourceOut: 2,
        },
        {
          id: "b",
          mediaId: "m",
          words: [{ id: "w-b", text: "b", start: 5.5, end: 6, confidence: 1 }],
          sourceIn: 5,
          sourceOut: 7,
        },
      ];
      expect(wordIdToOutputTime(p, "w-a")?.outputTime).toBeCloseTo(0.25);
      expect(wordIdToOutputTime(p, "w-b")?.outputTime).toBeCloseTo(2.5);
      expect(wordIdToOutputTime(p, "missing")).toBeNull();
    });
  });

  describe("wordIdsInOutputRange", () => {
    it("finds words overlapping an output-time timeline selection", () => {
      const p = newProject("t");
      p.segments = [
        {
          id: "a",
          mediaId: "m",
          words: [
            { id: "w-a", text: "a", start: 0, end: 0.5, confidence: 1 },
            { id: "w-b", text: "b", start: 0.5, end: 1, confidence: 1 },
          ],
          sourceIn: 0,
          sourceOut: 1,
        },
        {
          id: "b",
          mediaId: "m",
          words: [
            { id: "w-c", text: "c", start: 5, end: 5.5, confidence: 1 },
            { id: "w-d", text: "d", start: 5.5, end: 6, confidence: 1 },
          ],
          sourceIn: 5,
          sourceOut: 6,
        },
      ];

      expect(wordIdsInOutputRange(p, 0.25, 1.25)).toEqual(["w-a", "w-b", "w-c"]);
      expect(wordIdsInOutputRange(p, 1.25, 0.25)).toEqual(["w-a", "w-b", "w-c"]);
      expect(wordIdsInOutputRange(p, 2, 2)).toEqual([]);
    });
  });

  describe("nextSurvivingSegment", () => {
    it("returns the next segment in source order for the media", () => {
      const p = newProject("t");
      p.segments = [
        { id: "later", mediaId: "m", words: [], sourceIn: 5, sourceOut: 7 },
        { id: "earlier", mediaId: "m", words: [], sourceIn: 0, sourceOut: 2 },
      ];
      // Stored out of source order — function should still pick the right one.
      expect(nextSurvivingSegment(p, "m", 3)?.id).toBe("later");
      expect(nextSurvivingSegment(p, "m", 0)?.id).toBe("earlier");
      expect(nextSurvivingSegment(p, "m", 10)).toBeNull();
    });

    it("ignores other media files", () => {
      const p = newProject("t");
      p.segments = [
        { id: "x", mediaId: "other", words: [], sourceIn: 0, sourceOut: 100 },
      ];
      expect(nextSurvivingSegment(p, "m", 0)).toBeNull();
    });
  });

  describe("findWordAtSourceTime", () => {
    it("returns the word whose [start, end) brackets the time", () => {
      const seg = {
        id: "s",
        mediaId: "m",
        words: makeWords([
          ["a", 0, 0.5],
          ["b", 0.5, 1.0],
          ["c", 1.0, 1.5],
        ]),
        sourceIn: 0,
        sourceOut: 1.5,
      };
      expect(findWordAtSourceTime(seg, 0.2)?.text).toBe("a");
      expect(findWordAtSourceTime(seg, 0.5)?.text).toBe("b"); // [start, end) is half-open
      expect(findWordAtSourceTime(seg, 1.49)?.text).toBe("c");
      expect(findWordAtSourceTime(seg, 2)).toBeNull();
    });
  });

  describe("findWord", () => {
    it("locates a word by id across all segments", () => {
      const p = newProject("t");
      p.segments = [
        {
          id: "s1",
          mediaId: "m",
          words: makeWords([["a", 0, 1]]),
          sourceIn: 0,
          sourceOut: 1,
        },
        {
          id: "s2",
          mediaId: "m",
          words: makeWords([["b", 1, 2]]),
          sourceIn: 1,
          sourceOut: 2,
        },
      ];
      const found = findWord(p, "w-0");
      expect(found?.segmentIndex).toBe(0);
      expect(found?.wordIndex).toBe(0);
      expect(findWord(p, "missing")).toBeNull();
    });
  });

  describe("splitSegmentAtWord", () => {
    const seg = {
      id: "s",
      mediaId: "m",
      words: makeWords([
        ["one", 0, 1],
        ["two", 1, 2],
        ["three", 2, 3],
      ]),
      sourceIn: 0,
      sourceOut: 3,
    };

    it("returns original when splitting at boundary 0", () => {
      expect(splitSegmentAtWord(seg, 0)).toEqual([seg]);
    });

    it("returns original when splitting at boundary == length", () => {
      expect(splitSegmentAtWord(seg, 3)).toEqual([seg]);
    });

    it("splits cleanly at an interior boundary", () => {
      const [left, right] = splitSegmentAtWord(seg, 1);
      expect(left!.words.map((w) => w.text)).toEqual(["one"]);
      expect(right!.words.map((w) => w.text)).toEqual(["two", "three"]);
      // Boundary should sit between word 0's end (1.0) and word 1's start (1.0)
      expect(left!.sourceOut).toBeLessThanOrEqual(right!.sourceIn + 1e-9);
      expect(left!.sourceIn).toBe(0);
      expect(right!.sourceOut).toBe(3);
    });

    it("gives the new segments fresh ids", () => {
      const [left, right] = splitSegmentAtWord(seg, 1);
      expect(left!.id).not.toBe(seg.id);
      expect(right!.id).not.toBe(seg.id);
      expect(left!.id).not.toBe(right!.id);
    });
  });

  describe("deleteWords", () => {
    function fixture() {
      const p = newProject("t");
      const m = makeMedia({ duration: 4 });
      const words = makeWords([
        ["one", 0, 1],
        ["two", 1, 2],
        ["three", 2, 3],
        ["four", 3, 4],
      ]);
      return addMediaWithTranscript(p, m, words);
    }

    it("is a no-op for an empty selection", () => {
      const p = fixture();
      const next = deleteWords(p, new Set());
      expect(next).toBe(p);
    });

    it("deleting the entire range produces zero segments", () => {
      const p = fixture();
      const all = new Set(p.segments[0]!.words.map((w) => w.id));
      const next = deleteWords(p, all);
      expect(next.segments).toEqual([]);
      expect(totalDuration(next)).toBe(0);
    });

    it("deleting an interior word splits into two segments", () => {
      const p = fixture();
      const next = deleteWords(p, new Set(["w-1", "w-2"])); // drop "two" and "three"
      expect(next.segments).toHaveLength(2);
      expect(next.segments[0]!.words.map((w) => w.text)).toEqual(["one"]);
      expect(next.segments[1]!.words.map((w) => w.text)).toEqual(["four"]);
      // The kept ends/begins should sit at the original segment bounds (first/last run).
      expect(next.segments[0]!.sourceIn).toBe(0);
      expect(next.segments[1]!.sourceOut).toBe(4);
    });

    it("deleting a leading word preserves rest", () => {
      const p = fixture();
      const next = deleteWords(p, new Set(["w-0"]));
      expect(next.segments).toHaveLength(1);
      expect(next.segments[0]!.words.map((w) => w.text)).toEqual(["two", "three", "four"]);
      // Right end is original segment bound (last run)
      expect(next.segments[0]!.sourceOut).toBe(4);
    });

    it("deleting a trailing word preserves rest", () => {
      const p = fixture();
      const next = deleteWords(p, new Set(["w-3"]));
      expect(next.segments).toHaveLength(1);
      expect(next.segments[0]!.words.map((w) => w.text)).toEqual(["one", "two", "three"]);
      expect(next.segments[0]!.sourceIn).toBe(0);
    });

    it("respects paddingMs around interior cuts", () => {
      const p = fixture();
      // Override padding to a large, observable value (200ms)
      p.settings.paddingMs = 200;
      const next = deleteWords(p, new Set(["w-1", "w-2"]));
      // First kept run: only word "one" (start 0, end 1). isFirstRun → sourceIn = original (0). sourceOut = end + padding = 1.2
      expect(next.segments[0]!.sourceIn).toBe(0);
      expect(next.segments[0]!.sourceOut).toBeCloseTo(1.2);
      // Second kept run: word "four" (start 3, end 4). Last run → sourceOut = original (4). sourceIn = start - padding = 2.8
      expect(next.segments[1]!.sourceIn).toBeCloseTo(2.8);
      expect(next.segments[1]!.sourceOut).toBe(4);
    });

    it("never mutates the input project", () => {
      const p = fixture();
      const before = JSON.stringify(p);
      deleteWords(p, new Set(["w-1"]));
      expect(JSON.stringify(p)).toBe(before);
    });

    it("updates updatedAt", async () => {
      const p = fixture();
      const before = p.updatedAt;
      // Ensure clock advances by at least 1ms — Date.now resolution is ms, so wait.
      await new Promise((r) => setTimeout(r, 5));
      const next = deleteWords(p, new Set(["w-0"]));
      expect(next.updatedAt).not.toBe(before);
    });
  });

  describe("EDL invariants", () => {
    it("word source timecodes are never rewritten by edits", () => {
      const p = newProject("t");
      const m = makeMedia();
      const words = makeWords([
        ["a", 0, 1],
        ["b", 1, 2],
        ["c", 2, 3],
      ]);
      const p1 = addMediaWithTranscript(p, m, words);
      const p2 = deleteWords(p1, new Set(["w-1"]));
      // Word "a" in p2 must have the same start/end as in p1
      const aOriginal = p1.segments[0]!.words.find((w) => w.id === "w-0")!;
      const aAfter = p2.segments
        .flatMap((s) => s.words)
        .find((w) => w.id === "w-0")!;
      expect(aAfter.start).toBe(aOriginal.start);
      expect(aAfter.end).toBe(aOriginal.end);
    });
  });

  describe("removeSilences", () => {
    it("returns [project, 0] when there are no gaps", () => {
      const p = addMediaWithTranscript(
        newProject("t"),
        makeMedia(),
        makeWords([
          ["a", 0, 0.5],
          ["b", 0.55, 1.0],
          ["c", 1.05, 1.4],
        ]),
      );
      const [next, removed] = removeSilences(p, { gapMs: 600 });
      expect(removed).toBe(0);
      expect(next).toBe(p);
    });

    it("splits a segment at gaps longer than the threshold", () => {
      const p = addMediaWithTranscript(
        newProject("t"),
        makeMedia({ duration: 20 }),
        makeWords([
          ["a", 0, 0.5],
          ["b", 0.55, 1.0],
          // 2s silence here
          ["c", 3.0, 3.5],
          ["d", 3.55, 4.0],
        ]),
      );
      const [next, removed] = removeSilences(p, { gapMs: 600, paddingMs: 80 });
      expect(removed).toBe(1);
      expect(next.segments).toHaveLength(2);
      expect(next.segments[0]!.words.map((w) => w.text)).toEqual(["a", "b"]);
      expect(next.segments[1]!.words.map((w) => w.text)).toEqual(["c", "d"]);
      // The first run keeps its leading original boundary, the second run
      // starts no earlier than (c.start - padding).
      expect(next.segments[0]!.sourceIn).toBe(0);
      expect(next.segments[0]!.sourceOut).toBeCloseTo(1.08, 5);
      expect(next.segments[1]!.sourceIn).toBeCloseTo(2.92, 5);
      expect(next.segments[1]!.sourceOut).toBe(20);
    });

    it("removes multiple silences in a single segment", () => {
      const p = addMediaWithTranscript(
        newProject("t"),
        makeMedia({ duration: 30 }),
        makeWords([
          ["a", 0, 0.5],
          ["b", 5, 5.5],
          ["c", 10, 10.5],
          ["d", 15, 15.5],
        ]),
      );
      const [next, removed] = removeSilences(p, { gapMs: 600 });
      expect(removed).toBe(3);
      expect(next.segments).toHaveLength(4);
    });

    it("collapses output duration after silence removal", () => {
      const p = addMediaWithTranscript(
        newProject("t"),
        makeMedia({ duration: 20 }),
        makeWords([
          ["a", 0, 0.5],
          ["b", 0.55, 1.0],
          ["c", 10, 10.5],
        ]),
      );
      const beforeDuration = totalDuration(p);
      const [next, removed] = removeSilences(p, { gapMs: 600 });
      expect(removed).toBe(1);
      expect(totalDuration(next)).toBeLessThan(beforeDuration);
    });

    it("is idempotent once all gaps are gone", () => {
      const p = addMediaWithTranscript(
        newProject("t"),
        makeMedia({ duration: 20 }),
        makeWords([
          ["a", 0, 0.5],
          ["b", 5, 5.5],
        ]),
      );
      const [trimmed, removed1] = removeSilences(p);
      expect(removed1).toBe(1);
      const [again, removed2] = removeSilences(trimmed);
      expect(removed2).toBe(0);
      expect(again).toBe(trimmed);
    });
  });
});
