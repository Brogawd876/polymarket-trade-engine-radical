import { describe, expect, test } from "bun:test";
import { normalCDF, digitalCallProbability, calculateBrierScore } from "./math.ts";

describe("Quantitative Math Utilities", () => {
  test("normalCDF", () => {
    // Known values for Normal CDF
    expect(normalCDF(0)).toBeCloseTo(0.5, 5);
    expect(normalCDF(1)).toBeCloseTo(0.84134, 5);
    expect(normalCDF(-1)).toBeCloseTo(0.15866, 5);
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 2);
  });

  test("digitalCallProbability (Black-Scholes d2)", () => {
    // Scenario: BTC at 60k, Strike at 60k, 1 hour to expiry, 50% vol
    // Since S=K, d2 = (0 - 0.5^2 / 2) * T / (0.5 * sqrt(T)) = -0.25 * sqrt(T) / 0.5
    // For T=1/24/365, it should be very close to 0.5 but slightly below due to the sigma^2/2 term
    const p = digitalCallProbability(60000, 60000, 0.01, 0.20);
    expect(p).toBeLessThan(0.5);
    expect(p).toBeGreaterThan(0.48);

    // Deep in the money
    expect(digitalCallProbability(65000, 60000, 0.01, 0.10)).toBeCloseTo(1.0, 2);
    
    // Deep out of the money
    expect(digitalCallProbability(55000, 60000, 0.01, 0.10)).toBeCloseTo(0.0, 2);
  });

  test("calculateBrierScore", () => {
    // Perfect predictions
    expect(calculateBrierScore([1, 0], [1, 0])).toBe(0);
    
    // Total failure
    expect(calculateBrierScore([1, 0], [0, 1])).toBe(1);
    
    // No-skill baseline (0.5 for everything)
    expect(calculateBrierScore([0.5, 0.5], [1, 0])).toBe(0.25);
  });
});
