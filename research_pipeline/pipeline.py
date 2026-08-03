from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


PARTITIONS = ("training", "calibration", "policy", "final")

MODEL_FEATURES: dict[str, list[str]] = {
    "M1": ["oracleDistance", "remainingSeconds", "integratedVariance"],
    "M2": [
        "oracleDistance",
        "remainingSeconds",
        "integratedVariance",
        "predictiveReturn",
        "basis",
        "crossVenueDispersion",
        "sourceLatencyMs",
    ],
    "M3": [
        "oracleDistance",
        "remainingSeconds",
        "integratedVariance",
        "predictiveReturn",
        "basis",
        "crossVenueDispersion",
        "sourceLatencyMs",
        "bookImbalance",
        "orderFlowImbalance",
        "spread",
        "depth",
        "quoteAgeMs",
    ],
    "M4": [
        "oracleDistance",
        "remainingSeconds",
        "integratedVariance",
        "predictiveReturn",
        "basis",
        "crossVenueDispersion",
        "sourceLatencyMs",
        "bookImbalance",
        "orderFlowImbalance",
        "spread",
        "depth",
        "quoteAgeMs",
        "fillProbability",
        "expectedFillFraction",
        "conditionalWinProbability",
    ],
}

FILL_FEATURES = [
    "quotePrice",
    "distanceFromBestBid",
    "distanceFromBestAsk",
    "queueAhead",
    "orderSize",
    "quoteLifetimeMs",
    "remainingSeconds",
    "spread",
    "depth",
    "orderFlowImbalance",
    "bookImbalance",
    "predictiveReturn",
    "oracleDistance",
    "sourceLatencyMs",
    "integratedVariance",
    "cancellationState",
]


def sigmoid(value: float) -> float:
    if value >= 0:
        exp = math.exp(-value)
        return 1.0 / (1.0 + exp)
    exp = math.exp(value)
    return exp / (1.0 + exp)


def clip_probability(value: float) -> float:
    return min(1.0 - 1e-12, max(1e-12, value))


def brier(labels: list[int], probabilities: list[float]) -> float:
    return sum((p - y) ** 2 for y, p in zip(labels, probabilities)) / len(labels)


def log_loss(labels: list[int], probabilities: list[float]) -> float:
    return -sum(
        y * math.log(clip_probability(p))
        + (1 - y) * math.log(clip_probability(1 - p))
        for y, p in zip(labels, probabilities)
    ) / len(labels)


def dataset_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            required = {
                "marketId",
                "day",
                "decisionTimestampMs",
                "settlementWin",
                "marketMidpoint",
                "candidateClassification",
            }
            missing = required.difference(row)
            if missing:
                raise ValueError(
                    f"row {line_number} missing required fields: {sorted(missing)}"
                )
            if row["candidateClassification"] not in {
                "THEORETICAL",
                "RISK_BLOCKED",
                "SUBMITTED",
                "QUEUE_BLOCKED",
                "MISSED_FILL",
                "PARTIAL_FILL",
                "COMPLETE_FILL",
                "FILL_WIN",
                "FILL_LOSS",
            }:
                raise ValueError(f"row {line_number} has invalid candidate classification")
            rows.append(row)
    if not rows:
        raise ValueError("candidate dataset is empty")
    return rows


def chronological_partition(
    rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    market_start: dict[str, int] = {}
    for row in rows:
        market_start[row["marketId"]] = min(
            market_start.get(row["marketId"], row["decisionTimestampMs"]),
            row["decisionTimestampMs"],
        )
    markets = sorted(market_start, key=lambda market: (market_start[market], market))
    if len(markets) < 8:
        raise ValueError("at least eight markets are required for four-way splitting")
    cut_1 = max(1, int(len(markets) * 0.60))
    cut_2 = max(cut_1 + 1, int(len(markets) * 0.75))
    cut_3 = max(cut_2 + 1, int(len(markets) * 0.90))
    cut_3 = min(cut_3, len(markets) - 1)
    membership = {
        market: (
            "training"
            if index < cut_1
            else "calibration"
            if index < cut_2
            else "policy"
            if index < cut_3
            else "final"
        )
        for index, market in enumerate(markets)
    }
    result = {name: [] for name in PARTITIONS}
    for row in rows:
        result[membership[row["marketId"]]].append(row)
    if any(not result[name] for name in PARTITIONS):
        raise ValueError("chronological partition produced an empty cohort")
    for market in markets:
        containing = {
            name
            for name in PARTITIONS
            if any(row["marketId"] == market for row in result[name])
        }
        if len(containing) != 1:
            raise AssertionError(f"market leaked across partitions: {market}")
    return result


@dataclass
class Normalizer:
    means: list[float]
    scales: list[float]

    @classmethod
    def fit(cls, matrix: list[list[float]]) -> "Normalizer":
        columns = list(zip(*matrix))
        means = [sum(column) / len(column) for column in columns]
        scales = []
        for mean, column in zip(means, columns):
            variance = sum((value - mean) ** 2 for value in column) / len(column)
            scales.append(max(1e-12, math.sqrt(variance)))
        return cls(means, scales)

    def transform(self, matrix: list[list[float]]) -> list[list[float]]:
        return [
            [
                (value - self.means[index]) / self.scales[index]
                for index, value in enumerate(row)
            ]
            for row in matrix
        ]


@dataclass
class LogisticModel:
    coefficients: list[float]
    intercept: float

    def predict(self, matrix: list[list[float]]) -> list[float]:
        return [
            sigmoid(
                self.intercept
                + sum(
                    coefficient * value
                    for coefficient, value in zip(self.coefficients, row)
                )
            )
            for row in matrix
        ]


def fit_logistic(
    matrix: list[list[float]],
    labels: list[int],
    iterations: int = 1200,
    learning_rate: float = 0.04,
    l2: float = 0.01,
) -> LogisticModel:
    width = len(matrix[0])
    coefficients = [0.0] * width
    intercept = 0.0
    count = len(matrix)
    for _ in range(iterations):
        gradient = [0.0] * width
        intercept_gradient = 0.0
        for row, label in zip(matrix, labels):
            prediction = sigmoid(
                intercept
                + sum(c * value for c, value in zip(coefficients, row))
            )
            error = prediction - label
            intercept_gradient += error
            for index, value in enumerate(row):
                gradient[index] += error * value
        intercept -= learning_rate * intercept_gradient / count
        for index in range(width):
            coefficients[index] -= learning_rate * (
                gradient[index] / count + l2 * coefficients[index]
            )
    return LogisticModel(coefficients, intercept)


def fit_platt(raw_probabilities: list[float], labels: list[int]) -> LogisticModel:
    logits = [
        [math.log(clip_probability(p) / clip_probability(1 - p))]
        for p in raw_probabilities
    ]
    return fit_logistic(logits, labels, iterations=800, learning_rate=0.03, l2=0.0)


def apply_platt(
    probabilities: list[float], calibrator: LogisticModel
) -> list[float]:
    return [
        sigmoid(
            calibrator.intercept
            + calibrator.coefficients[0]
            * math.log(clip_probability(p) / clip_probability(1 - p))
        )
        for p in probabilities
    ]


def matrix_for(rows: list[dict[str, Any]], features: list[str]) -> list[list[float]]:
    matrix = []
    for row in rows:
        values = []
        for feature in features:
            value = row.get(feature)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(
                    f"market {row['marketId']} missing finite feature {feature}"
                )
            values.append(float(value))
        matrix.append(values)
    return matrix


def clustered_bootstrap_standard_error(
    rows: list[dict[str, Any]],
    probabilities: list[float],
    iterations: int = 300,
) -> float:
    # Deterministic cluster resampling avoids a hidden random seed.
    clusters: dict[tuple[str, str], list[int]] = {}
    for index, row in enumerate(rows):
        clusters.setdefault((row["marketId"], row["day"]), []).append(index)
    keys = sorted(clusters)
    if len(keys) < 2:
        return 0.0
    scores: list[float] = []
    state = 0xC0FFEE
    for _ in range(iterations):
        sampled_indices: list[int] = []
        for _ in keys:
            state = (1103515245 * state + 12345) % (2**31)
            sampled_indices.extend(clusters[keys[state % len(keys)]])
        labels = [int(rows[index]["settlementWin"]) for index in sampled_indices]
        probs = [probabilities[index] for index in sampled_indices]
        scores.append(brier(labels, probs))
    mean = sum(scores) / len(scores)
    return math.sqrt(sum((score - mean) ** 2 for score in scores) / len(scores))


def evaluate_model(
    model: LogisticModel,
    normalizer: Normalizer,
    features: list[str],
    rows: list[dict[str, Any]],
    calibrator: LogisticModel,
) -> tuple[list[float], dict[str, float]]:
    raw = model.predict(normalizer.transform(matrix_for(rows, features)))
    calibrated = apply_platt(raw, calibrator)
    labels = [int(row["settlementWin"]) for row in rows]
    return calibrated, {
        "brier": brier(labels, calibrated),
        "logLoss": log_loss(labels, calibrated),
    }


def fill_class(row: dict[str, Any]) -> int:
    classification = row["candidateClassification"]
    if classification in {
        "THEORETICAL",
        "RISK_BLOCKED",
        "QUEUE_BLOCKED",
        "MISSED_FILL",
        "SUBMITTED",
    }:
        return 0
    return 1 if int(row["settlementWin"]) == 1 else 2


def train_conditional_fill(
    split: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    try:
        training_matrix = matrix_for(split["training"], FILL_FEATURES)
        normalizer = Normalizer.fit(training_matrix)
        normalized = normalizer.transform(training_matrix)
    except ValueError:
        return None
    labels = [fill_class(row) for row in split["training"]]
    models = [
        fit_logistic(normalized, [1 if label == class_index else 0 for label in labels])
        for class_index in range(3)
    ]
    filled_fractions = [
        float(row.get("realizedFillFraction", 0.0))
        for row in split["training"]
        if fill_class(row) != 0
    ]
    mean_fraction = (
        sum(filled_fractions) / len(filled_fractions)
        if filled_fractions
        else 0.5
    )
    fraction_intercept = math.log(
        clip_probability(mean_fraction)
        / clip_probability(1 - mean_fraction)
    )

    final_matrix = normalizer.transform(matrix_for(split["final"], FILL_FEATURES))
    losses = []
    correct = 0
    for row, values in zip(split["final"], final_matrix):
        logits = [
            model.intercept
            + sum(c * value for c, value in zip(model.coefficients, values))
            for model in models
        ]
        maximum = max(logits)
        exponentials = [math.exp(value - maximum) for value in logits]
        total = sum(exponentials)
        probabilities = [value / total for value in exponentials]
        label = fill_class(row)
        losses.append(-math.log(clip_probability(probabilities[label])))
        correct += int(max(range(3), key=lambda index: probabilities[index]) == label)
    return {
        "features": FILL_FEATURES,
        "normalizer": normalizer,
        "models": models,
        "fractionIntercept": fraction_intercept,
        "metrics": {
            "logLoss": sum(losses) / len(losses),
            "accuracy": correct / len(final_matrix),
        },
        "trainingStartMs": min(row["decisionTimestampMs"] for row in split["training"]),
        "trainingEndMs": max(row["decisionTimestampMs"] for row in split["training"]),
    }


def train_pipeline(rows: list[dict[str, Any]]) -> dict[str, Any]:
    split = chronological_partition(rows)
    ladder: dict[str, Any] = {}
    policy_labels = [int(row["settlementWin"]) for row in split["policy"]]
    midpoint_policy = [float(row["marketMidpoint"]) for row in split["policy"]]
    ladder["M0"] = {
        "policyBrier": brier(policy_labels, midpoint_policy),
        "policyLogLoss": log_loss(policy_labels, midpoint_policy),
    }

    trained: dict[str, tuple[LogisticModel, Normalizer, LogisticModel]] = {}
    for name, features in MODEL_FEATURES.items():
        training_matrix = matrix_for(split["training"], features)
        normalizer = Normalizer.fit(training_matrix)
        model = fit_logistic(
            normalizer.transform(training_matrix),
            [int(row["settlementWin"]) for row in split["training"]],
        )
        calibration_raw = model.predict(
            normalizer.transform(matrix_for(split["calibration"], features))
        )
        calibrator = fit_platt(
            calibration_raw,
            [int(row["settlementWin"]) for row in split["calibration"]],
        )
        _, policy_metrics = evaluate_model(
            model, normalizer, features, split["policy"], calibrator
        )
        ladder[name] = {
            "policyBrier": policy_metrics["brier"],
            "policyLogLoss": policy_metrics["logLoss"],
        }
        trained[name] = (model, normalizer, calibrator)

    selected = min(ladder, key=lambda name: ladder[name]["policyBrier"])
    if selected == "M0":
        return {
            "status": "NO_INCREMENTAL_VALUE",
            "selected": selected,
            "ladder": ladder,
            "partitions": {
                name: sorted({row["marketId"] for row in split[name]})
                for name in PARTITIONS
            },
            "fillModel": train_conditional_fill(split),
        }

    model, normalizer, calibrator = trained[selected]
    features = MODEL_FEATURES[selected]
    final_probabilities, final_metrics = evaluate_model(
        model, normalizer, features, split["final"], calibrator
    )
    standard_error = clustered_bootstrap_standard_error(
        split["final"], final_probabilities
    )
    return {
        "status": "CANDIDATE_READY_FOR_REVIEW",
        "selected": selected,
        "ladder": ladder,
        "finalMetrics": final_metrics,
        "clusteredBrierStandardError": standard_error,
        "partitions": {
            name: sorted({row["marketId"] for row in split[name]})
            for name in PARTITIONS
        },
        "model": model,
        "normalizer": normalizer,
        "calibrator": calibrator,
        "features": features,
        "trainingStartMs": min(row["decisionTimestampMs"] for row in split["training"]),
        "trainingEndMs": max(row["decisionTimestampMs"] for row in split["training"]),
        "fillModel": train_conditional_fill(split),
    }


def export_artifact(
    result: dict[str, Any],
    source_path: Path,
    output_directory: Path,
    code_commit: str,
) -> Path | None:
    output_directory.mkdir(parents=True, exist_ok=True)
    report_path = output_directory / "training-report.json"
    serializable_report = {
        key: value
        for key, value in result.items()
        if key not in {"model", "normalizer", "calibrator", "fillModel"}
    }
    report_path.write_text(
        json.dumps(serializable_report, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    fill_result = result.get("fillModel")
    if fill_result:
        fill_models: list[LogisticModel] = fill_result["models"]
        fill_normalizer: Normalizer = fill_result["normalizer"]
        fill_artifact: dict[str, Any] = {
            "schemaVersion": 1,
            "artifactId": f"fill-{dataset_hash(source_path)[:12]}",
            "artifactKind": "CONDITIONAL_FILL",
            "featureSchemaVersion": 1,
            "canonicalStateSchemaVersion": 1,
            "featureNames": fill_result["features"],
            "preprocessing": {
                "means": fill_normalizer.means,
                "scales": fill_normalizer.scales,
            },
            "model": {
                "type": "MULTINOMIAL_LOGISTIC",
                "classes": ["NO_FILL", "FILL_WIN", "FILL_LOSS"],
                "coefficients": [model.coefficients for model in fill_models],
                "intercepts": [model.intercept for model in fill_models],
                "expectedFillFraction": {
                    "coefficients": [0.0] * len(fill_result["features"]),
                    "intercept": fill_result["fractionIntercept"],
                },
            },
            "trainingPeriod": {
                "startMs": fill_result["trainingStartMs"],
                "endMs": fill_result["trainingEndMs"],
            },
            "datasetHash": dataset_hash(source_path),
            "codeCommit": code_commit,
            "metrics": fill_result["metrics"],
            "expiresAtMs": fill_result["trainingEndMs"] + 30 * 24 * 60 * 60 * 1000,
            "driftLimits": {
                "fillRateShift": 0.10,
                "markoutShiftZ": 3.0,
                "conditionalWinRateShift": 0.10,
            },
            "approval": {
                "approved": False,
                "approvedAtMs": None,
                "approvedBy": None,
            },
        }
        fill_canonical = json.dumps(
            fill_artifact, sort_keys=True, separators=(",", ":")
        )
        fill_artifact["artifactHash"] = hashlib.sha256(
            fill_canonical.encode()
        ).hexdigest()
        (output_directory / "fill-model.unapproved.json").write_text(
            json.dumps(fill_artifact, indent=2, sort_keys=True),
            encoding="utf-8",
        )
    if result["status"] != "CANDIDATE_READY_FOR_REVIEW":
        return None
    model: LogisticModel = result["model"]
    normalizer: Normalizer = result["normalizer"]
    calibrator: LogisticModel = result["calibrator"]
    artifact: dict[str, Any] = {
        "schemaVersion": 1,
        "artifactId": f"settlement-{result['selected'].lower()}-{dataset_hash(source_path)[:12]}",
        "artifactKind": "SETTLEMENT_PROBABILITY",
        "featureSchemaVersion": 1,
        "canonicalStateSchemaVersion": 1,
        "featureNames": result["features"],
        "preprocessing": {
            "means": normalizer.means,
            "scales": normalizer.scales,
        },
        "model": {
            "type": "LOGISTIC",
            "coefficients": model.coefficients,
            "intercept": model.intercept,
        },
        "calibrator": {
            "type": "PLATT",
            "slope": calibrator.coefficients[0],
            "intercept": calibrator.intercept,
        },
        "uncertainty": {
            "clusteredStandardError": result["clusteredBrierStandardError"],
            "zAlpha": 1.64,
        },
        "trainingPeriod": {
            "startMs": result["trainingStartMs"],
            "endMs": result["trainingEndMs"],
        },
        "datasetHash": dataset_hash(source_path),
        "codeCommit": code_commit,
        "metrics": result["finalMetrics"],
        "expiresAtMs": result["trainingEndMs"] + 30 * 24 * 60 * 60 * 1000,
        "driftLimits": {
            "featurePsi": 0.20,
            "basisShiftZ": 3.0,
            "latencyShiftZ": 3.0,
            "calibrationResidual": 0.05,
        },
        "approval": {
            "approved": False,
            "approvedAtMs": None,
            "approvedBy": None,
        },
    }
    canonical = json.dumps(artifact, sort_keys=True, separators=(",", ":"))
    artifact["artifactHash"] = hashlib.sha256(canonical.encode()).hexdigest()
    output_path = output_directory / "settlement-model.unapproved.json"
    output_path.write_text(
        json.dumps(artifact, indent=2, sort_keys=True), encoding="utf-8"
    )
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--code-commit", default=os.getenv("GIT_COMMIT", "local"))
    args = parser.parse_args()
    rows = load_rows(args.input)
    result = train_pipeline(rows)
    artifact = export_artifact(result, args.input, args.output, args.code_commit)
    print(
        json.dumps(
            {
                "status": result["status"],
                "selected": result["selected"],
                "artifact": str(artifact) if artifact else None,
            }
        )
    )


if __name__ == "__main__":
    main()
