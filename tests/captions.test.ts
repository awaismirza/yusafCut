import { describe, it, expect } from "vitest";
import {
  buildCues,
  buildSrt,
  buildVtt,
  formatSrtTimestamp,
  formatVttTimestamp,
} from "@/lib/captions";
import {
  addMediaWithTranscript,
  deleteWords,
  newProject,
  type SourceMedia,
  type Word,
} from "@/lib/edl";

function media(): SourceMedia {
  return {
    id: "m1",
    path: "/tmp/x.mp4",
    duration: 60,
    fps: 30,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    sha256: "abc",
  };
}

function words(spec: Array<[string, number, number]>): Word[] {
  return spec.map(([text, start, end], i) => ({
    id: `w${i}`,
    text,
    start,
    end,
    confidence: 0.99,
  }));
}

describe("captions: timestamps", () => {
  it("formats SRT timestamps with comma separator", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(1.234)).toBe("00:00:01,234");
    expect(formatSrtTimestamp(3661.5)).toBe("01:01:01,500");
  });

  it("formats VTT timestamps with dot separator", () => {
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    expect(formatVttTimestamp(1.234)).toBe("00:00:01.234");
  });

  it("rounds millis half-up", () => {
    expect(formatSrtTimestamp(0.0009)).toBe("00:00:00,001");
  });
});

describe("captions: cue grouping", () => {
  it("groups contiguous words into a single cue", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["hello", 0, 0.5],
        ["world", 0.55, 1.0],
        ["again", 1.05, 1.4],
      ]),
    );
    const cues = buildCues(proj);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("hello world again");
    expect(cues[0]!.start).toBeCloseTo(0, 5);
    expect(cues[0]!.end).toBeCloseTo(1.4, 5);
  });

  it("starts a new cue after a >0.7s gap", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["first", 0, 0.5],
        ["clause", 0.55, 1.0],
        // 1.5s of silence here
        ["second", 2.5, 3.0],
        ["clause", 3.05, 3.4],
      ]),
    );
    const cues = buildCues(proj);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("first clause");
    expect(cues[1]!.text).toBe("second clause");
    expect(cues[1]!.index).toBe(2);
  });

  it("splits a cue when it would exceed 5 seconds", () => {
    const longSpeech = Array.from({ length: 30 }, (_, i): [string, number, number] => [
      `word${i}`,
      i * 0.4,
      i * 0.4 + 0.35,
    ]);
    const proj = addMediaWithTranscript(newProject("p"), media(), words(longSpeech));
    const cues = buildCues(proj);
    expect(cues.length).toBeGreaterThan(1);
    // The split fires once the current cue would exceed MAX_CUE_S (5s); the
    // final word in the cue can extend slightly past 5s before the next word
    // pushes us into a new cue. Half a word is a reasonable upper bound.
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(5.5);
    }
  });

  it("reflects deleted words in output-time", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["keep", 0, 0.5],
        ["delete-me", 0.55, 1.0],
        ["keep-too", 1.05, 1.4],
      ]),
    );
    const trimmed = deleteWords(proj, new Set(["w1"]));
    const cues = buildCues(trimmed);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).not.toContain("delete-me");
    // Output time of the second kept word lands much closer to the first than
    // its source-time position (1.05s). With 80ms padding around the cut the
    // second word lands near 0.66s in output-time; we just need to confirm the
    // gap collapsed below the unedited 1.05s.
    expect(cues[0]!.end).toBeLessThan(1.05);
  });
});

describe("captions: serialisation", () => {
  it("produces a valid SRT with index, arrow, blank line", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["hello", 0, 0.5],
        ["world", 0.55, 1.0],
      ]),
    );
    const srt = buildSrt(proj);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nhello world\n");
  });

  it("produces a VTT with WEBVTT header and dot timestamps", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["hello", 0, 0.5],
        ["world", 0.55, 1.0],
      ]),
    );
    const vtt = buildVtt(proj);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.000\nhello world\n");
  });

  it("returns an empty SRT for an empty project", () => {
    const proj = newProject("p");
    expect(buildSrt(proj)).toBe("");
    expect(buildVtt(proj)).toBe("WEBVTT\n\n");
  });
});
