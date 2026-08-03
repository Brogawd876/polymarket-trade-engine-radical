import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { fairValueMaker } from "../../engine/strategy/fair-value-maker.ts";
import {
  resolveStrategySelection,
  strategyVariants,
} from "../../engine/strategy/index.ts";

const FROZEN_IMPLEMENTATION_SHA256 =
  "09fc5865fdcd57e4b4f7a5997e6b69f5cecb99db07d36b4af7b72c8ecbb21154";
const FROZEN_ENTRY_POINT_SHA256 =
  "ff9bf414de740754d0562562e940e6683383a757bca263d53f73af124b9a3cb3";

describe("frozen FVM v1.1.0 Raw/Ungated research benchmark", () => {
  test("uses a separate immutable implementation and exact repository-equivalent config", () => {
    const resolved = resolveStrategySelection("fvm-v1.1.0-raw-ungated");
    expect(resolved.strategy).not.toBe(fairValueMaker);
    expect(resolved.config).toEqual({
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      sharesMode: "fixed",
      shares: 5,
      minShares: 5,
      divergenceThresholdAbs: 200,
    });
    expect(resolved.variant.paperEligible).toBe(false);
    expect(
      Object.isFrozen(
        strategyVariants["fvm-v1.1.0-raw-ungated"]!.config,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(strategyVariants["fvm-v1.1.0-raw-ungated"]),
    ).toBe(true);
  });

  test("fails if the frozen entry point or delegated implementation changes", () => {
    const strategyDirectory = join(
      import.meta.dir,
      "..",
      "..",
      "engine",
      "strategy",
    );
    const digest = (filename: string) =>
      createHash("sha256")
        .update(
          readFileSync(join(strategyDirectory, filename), "utf8").replace(
            /\r\n/g,
            "\n",
          ),
        )
        .digest("hex");
    expect(digest("fair-value-maker.ts")).toBe(
      FROZEN_IMPLEMENTATION_SHA256,
    );
    expect(digest("fair-value-maker-v1-1-0-raw-ungated.ts")).toBe(
      FROZEN_ENTRY_POINT_SHA256,
    );
  });

  test("does not expose the internal benchmark implementation without its frozen config", () => {
    expect(() =>
      resolveStrategySelection("fvm-v1.1.0-raw-ungated-benchmark"),
    ).toThrow(/Unknown strategy variant/);
  });
});
