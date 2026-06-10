# Continuous-Bankroll Comparison

Continuous-bankroll runner can be smoke-tested, but profitability cannot be concluded from this corpus.

**Baseline**: fvm-v1.1.0-raw-ungated
**Descendant**: fvm-v1.3.0-profit-selective

## Results
1. Did the current descendant beat FVM v1.1.0 Raw/Ungated? Baseline PnL: 0, Descendant PnL: 0
2. Did drawdown improve or worsen? Baseline DD: 0, Descendant DD: 0
3. Did fill count improve or worsen? Baseline Fills: 0, Descendant Fills: 0
4. Did order churn reduce? Baseline Trades: 0, Descendant Trades: 0
5. Did reduced churn preserve PnL or kill edge? (See PnL above)
6. Did wallet accounting reconcile? Yes, no wallet invariant violations occurred.
7. Is this enough for paper trading? No, because this is a synthetic smoke test.
8. If not, what is the single next bottleneck? We need a real paired corpus (historical L2 data mapped to Chainlink resolutions) to run a meaningful continuous-bankroll profitability test.