import { describe, it, expect } from "vitest";
import { formatDuration, formatTimecode, parseTimecode } from "@/lib/timecode";

describe("timecode", () => {
  describe("formatTimecode", () => {
    it("formats sub-hour as MM:SS.mmm", () => {
      expect(formatTimecode(0)).toBe("00:00.000");
      expect(formatTimecode(65.250)).toBe("01:05.250");
    });

    it("formats >= 1 hour as HH:MM:SS.mmm", () => {
      expect(formatTimecode(3661.5)).toBe("01:01:01.500");
    });

    it("omits ms when ms:false", () => {
      expect(formatTimecode(65.5, { ms: false })).toBe("01:05");
    });

    it("handles negative values", () => {
      expect(formatTimecode(-5)).toBe("-00:05.000");
    });
  });

  describe("formatDuration", () => {
    it("renders short forms", () => {
      expect(formatDuration(5)).toBe("5s");
      expect(formatDuration(125)).toBe("2m 5s");
      expect(formatDuration(3600)).toBe("1h 0m");
      expect(formatDuration(3725)).toBe("1h 2m");
    });
  });

  describe("parseTimecode", () => {
    it("parses MM:SS", () => {
      expect(parseTimecode("01:05")).toBe(65);
    });

    it("parses HH:MM:SS", () => {
      expect(parseTimecode("01:01:01")).toBe(3661);
    });

    it("parses fractional seconds", () => {
      expect(parseTimecode("00:01.500")).toBe(1.5);
      expect(parseTimecode("00:01.5")).toBe(1.5);
    });

    it("returns NaN on garbage", () => {
      expect(parseTimecode("abc")).toBeNaN();
      expect(parseTimecode("")).toBeNaN();
    });
  });
});
