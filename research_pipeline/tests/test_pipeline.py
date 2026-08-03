import json
import math
import tempfile
import unittest
from pathlib import Path

from research_pipeline.pipeline import (
    chronological_partition,
    export_artifact,
    load_rows,
    train_pipeline,
)


def rows(count: int = 20):
    result = []
    for market in range(count):
        for snapshot in range(2):
            signal = -1.0 if market % 2 == 0 else 1.0
            result.append(
                {
                    "marketId": f"market-{market:02d}",
                    "day": f"2026-01-{1 + market // 4:02d}",
                    "decisionTimestampMs": market * 1000 + snapshot,
                    "settlementWin": 1 if signal > 0 else 0,
                    "marketMidpoint": 0.5,
                    "candidateClassification": "THEORETICAL",
                    "oracleDistance": signal,
                    "remainingSeconds": 60 - snapshot,
                    "integratedVariance": 0.01,
                    "predictiveReturn": signal,
                    "basis": 0.0,
                    "crossVenueDispersion": 0.01,
                    "sourceLatencyMs": 10,
                    "bookImbalance": signal,
                    "orderFlowImbalance": signal,
                    "spread": 0.02,
                    "depth": 100,
                    "quoteAgeMs": 20,
                    "fillProbability": 0.5,
                    "expectedFillFraction": 0.5,
                    "conditionalWinProbability": 0.7 if signal > 0 else 0.3,
                    "quotePrice": 0.5,
                    "distanceFromBestBid": 0.01,
                    "distanceFromBestAsk": 0.01,
                    "queueAhead": 2,
                    "orderSize": 5,
                    "quoteLifetimeMs": 1000,
                    "cancellationState": 0,
                    "realizedFillFraction": 0.0,
                }
            )
    return result


class PipelineTests(unittest.TestCase):
    def test_market_level_four_way_split_has_no_leakage(self):
        split = chronological_partition(rows())
        memberships = {}
        for name, partition in split.items():
            for row in partition:
                memberships.setdefault(row["marketId"], set()).add(name)
        self.assertTrue(all(len(value) == 1 for value in memberships.values()))
        self.assertTrue(all(split[name] for name in split))

    def test_model_ladder_uses_policy_then_untouched_final(self):
        result = train_pipeline(rows())
        self.assertEqual(result["status"], "CANDIDATE_READY_FOR_REVIEW")
        self.assertNotEqual(result["selected"], "M0")
        self.assertLess(result["finalMetrics"]["brier"], 0.25)

    def test_export_is_frozen_but_unapproved(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "candidates.ndjson"
            source.write_text(
                "\n".join(json.dumps(row) for row in rows()), encoding="utf-8"
            )
            loaded = load_rows(source)
            result = train_pipeline(loaded)
            artifact_path = export_artifact(
                result, source, Path(directory) / "output", "abc"
            )
            self.assertIsNotNone(artifact_path)
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            self.assertFalse(artifact["approval"]["approved"])
            self.assertEqual(len(artifact["datasetHash"]), 64)
            self.assertEqual(len(artifact["artifactHash"]), 64)
            fill_artifact = json.loads(
                (Path(directory) / "output" / "fill-model.unapproved.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertFalse(fill_artifact["approval"]["approved"])
            self.assertEqual(
                fill_artifact["model"]["classes"],
                ["NO_FILL", "FILL_WIN", "FILL_LOSS"],
            )


if __name__ == "__main__":
    unittest.main()
