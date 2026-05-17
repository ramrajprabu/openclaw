import type { NormalizedUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCopilotSdkAssistantUsage,
  deriveCopilotSdkUsageTotal,
  normalizeCopilotSdkUsage,
} from "./usage-bridge.js";

const ZERO_SNAPSHOT: NormalizedUsage = {
  cacheRead: undefined,
  cacheWrite: undefined,
  input: undefined,
  output: undefined,
  total: 0,
};

describe("usage-bridge", () => {
  describe("normalizeCopilotSdkUsage", () => {
    it("normalizes SDK inputTokens and outputTokens into NormalizedUsage", () => {
      expect(normalizeCopilotSdkUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 10,
        output: 5,
        total: 15,
      });
    });

    it("normalizes SDK cacheReadTokens and cacheWriteTokens when present", () => {
      expect(normalizeCopilotSdkUsage({ cacheReadTokens: 3, cacheWriteTokens: 4 })).toEqual({
        cacheRead: 3,
        cacheWrite: 4,
        input: undefined,
        output: undefined,
        total: 7,
      });
    });

    it("leaves missing cache token fields undefined rather than zero", () => {
      const usage = normalizeCopilotSdkUsage({ inputTokens: 2 });

      expect(usage).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 2,
        output: undefined,
        total: 2,
      });
      expect(usage?.cacheRead).toBeUndefined();
      expect(usage?.cacheWrite).toBeUndefined();
    });

    it("returns a defined zero-snapshot when SDK event is an object with no valid fields", () => {
      expect(normalizeCopilotSdkUsage({})).toEqual(ZERO_SNAPSHOT);
      expect(normalizeCopilotSdkUsage({ inputTokens: undefined })).toEqual(ZERO_SNAPSHOT);
    });

    it("returns undefined for null / non-object input", () => {
      expect(normalizeCopilotSdkUsage(null)).toBeUndefined();
      expect(normalizeCopilotSdkUsage(undefined)).toBeUndefined();
      expect(normalizeCopilotSdkUsage("usage")).toBeUndefined();
    });

    it("ignores string-typed token counts", () => {
      expect(normalizeCopilotSdkUsage({ inputTokens: "5" })).toEqual(ZERO_SNAPSHOT);
    });

    it("ignores NaN and Infinity token counts", () => {
      expect(normalizeCopilotSdkUsage({ inputTokens: Number.NaN })).toEqual(ZERO_SNAPSHOT);
      expect(normalizeCopilotSdkUsage({ outputTokens: Number.POSITIVE_INFINITY })).toEqual(
        ZERO_SNAPSHOT,
      );
      expect(normalizeCopilotSdkUsage({ cacheReadTokens: Number.NEGATIVE_INFINITY })).toEqual(
        ZERO_SNAPSHOT,
      );
      expect(normalizeCopilotSdkUsage({ inputTokens: 2, outputTokens: Number.NaN })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 2,
        output: undefined,
        total: 2,
      });
    });

    it("clamps negative token counts to zero", () => {
      expect(normalizeCopilotSdkUsage({ inputTokens: -3 })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 0,
        output: undefined,
        total: 0,
      });
    });

    it("truncates fractional token counts", () => {
      expect(normalizeCopilotSdkUsage({ inputTokens: 3.7 })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 3,
        output: undefined,
        total: 3,
      });
    });

    it("derives total from normalized SDK component counts for compatibility", () => {
      expect(
        normalizeCopilotSdkUsage({
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          inputTokens: 1,
          outputTokens: 2,
        }),
      ).toEqual({
        cacheRead: 3,
        cacheWrite: 4,
        input: 1,
        output: 2,
        total: 10,
      });
    });

    it("does not mutate the caller-provided SDK event data", () => {
      const data = Object.freeze({ inputTokens: 4, outputTokens: 6 });

      expect(normalizeCopilotSdkUsage(data)).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 4,
        output: 6,
        total: 10,
      });
      expect(data).toEqual({ inputTokens: 4, outputTokens: 6 });
    });

    it("only whitelists known SDK fields and ignores unrelated input keys", () => {
      expect(
        normalizeCopilotSdkUsage({
          inputTokens: 5,
          malicious_field: 999,
          outputTokens: "bad",
          prompt_tokens: 100,
        }),
      ).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 5,
        output: undefined,
        total: 5,
      });
    });
  });

  describe("buildCopilotSdkAssistantUsage", () => {
    it("builds rich AssistantMessage usage with zero cost fields", () => {
      expect(
        buildCopilotSdkAssistantUsage({
          usage: { cacheRead: 3, cacheWrite: 4, input: 1, output: 2, total: 10 },
        }),
      ).toEqual({
        cacheRead: 3,
        cacheWrite: 4,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 1,
        output: 2,
        totalTokens: 10,
      });
    });

    it("defaults missing usage fields to zero in the rich block only", () => {
      expect(
        buildCopilotSdkAssistantUsage({
          usage: { input: 4 },
        }),
      ).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 4,
        output: 0,
        totalTokens: 0,
      });
    });

    it("uses fallback outputTokens when no usage event was captured", () => {
      expect(buildCopilotSdkAssistantUsage({ fallbackOutputTokens: 7 })).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 0,
        output: 7,
        totalTokens: 7,
      });
    });

    it("does not use fallback outputTokens when normalized usage is already present", () => {
      expect(
        buildCopilotSdkAssistantUsage({
          fallbackOutputTokens: 9,
          usage: { input: 4, total: 4 },
        }),
      ).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 4,
        output: 0,
        totalTokens: 4,
      });
    });

    it("returns an all-zero block when both usage and fallback are missing", () => {
      expect(buildCopilotSdkAssistantUsage({})).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 0,
        output: 0,
        totalTokens: 0,
      });
    });
  });

  describe("deriveCopilotSdkUsageTotal", () => {
    it("returns undefined when usage is undefined", () => {
      expect(deriveCopilotSdkUsageTotal(undefined)).toBeUndefined();
    });

    it("sums input/output/cacheRead/cacheWrite for total", () => {
      const usage: NormalizedUsage = {
        cacheRead: 3,
        cacheWrite: 4,
        input: 1,
        output: 2,
        total: 999,
      };

      expect(deriveCopilotSdkUsageTotal(usage)).toBe(10);
    });
  });
});
