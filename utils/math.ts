/**
 * Professional Quantitative Math Utilities
 * 
 * Implements standard Normal distribution functions and binary option pricing 
 * used for calculating fair value on prediction markets.
 */

/**
 * Standard Normal Cumulative Distribution Function (CDF).
 * Uses the Abramowitz and Stegun (7.1.26) approximation.
 * Accuracy: absolute error less than 1.5 x 10^-7.
 */
export function normalCDF(x: number): number {
  const p = 0.2316419;
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;

  const t = 1 / (1 + p * Math.abs(x));
  const poly = a1 * t + a2 * Math.pow(t, 2) + a3 * Math.pow(t, 3) + a4 * Math.pow(t, 4) + a5 * Math.pow(t, 5);
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-Math.pow(x, 2) / 2);
  const result = 1 - phi * poly;

  return x >= 0 ? result : 1 - result;
}

/**
 * Calculates the theoretical probability of a Digital Call Option finishing in the money.
 * For a unit payout ($1), this is effectively the "Fair Value" on Polymarket.
 * 
 * @param S Current Price of the underlying asset (e.g. BTC)
 * @param K Strike Price (e.g. Open Price for the round)
 * @param T Time to expiry in years
 * @param sigma Annualized volatility (standard deviation)
 * @param r Risk-free interest rate (defaults to 0 for short durations)
 */
export function digitalCallProbability(S: number, K: number, T: number, sigma: number, r: number = 0): number {
  if (T <= 0 || sigma <= 0) return S >= K ? 1 : 0;
  
  // d2 = [ln(S/K) + (r - sigma^2 / 2) * T] / (sigma * sqrt(T))
  const d2 = (Math.log(S / K) + (r - Math.pow(sigma, 2) / 2) * T) / (sigma * Math.sqrt(T));
  return normalCDF(d2);
}

/**
 * Brier Score: (1/N) * sum((forecast - outcome)^2)
 * Forecast is a probability [0, 1], Outcome is 1 (UP) or 0 (DOWN).
 * Lower is better (0 is perfect, 0.25 is no-skill baseline).
 */
export function calculateBrierScore(forecasts: number[], outcomes: (0 | 1)[]): number {
  if (forecasts.length === 0 || forecasts.length !== outcomes.length) return 1.0;
  let sum = 0;
  for (let i = 0; i < forecasts.length; i++) {
    sum += Math.pow(forecasts[i]! - outcomes[i]!, 2);
  }
  return sum / forecasts.length;
}

/**
 * Log Loss (Cross-Entropy): -(1/N) * sum(y*log(p) + (1-y)*log(1-p))
 * Heavily penalizes "confident and wrong" predictions.
 */
export function calculateLogLoss(forecasts: number[], outcomes: (0 | 1)[]): number {
  if (forecasts.length === 0 || forecasts.length !== outcomes.length) return 1.0;
  let sum = 0;
  const eps = 1e-15; // clipping to avoid log(0)
  for (let i = 0; i < forecasts.length; i++) {
    const p = Math.max(eps, Math.min(1 - eps, forecasts[i]!));
    const y = outcomes[i]!;
    sum += y * Math.log(p) + (1 - y) * Math.log(1 - p);
  }
  return -sum / forecasts.length;
}
