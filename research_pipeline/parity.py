from __future__ import annotations

import json
import hashlib
import math
import sys


def sigmoid(value: float) -> float:
    if value >= 0:
        exp = math.exp(-value)
        return 1.0 / (1.0 + exp)
    exp = math.exp(value)
    return exp / (1.0 + exp)


def evaluate(payload: dict) -> dict:
    artifact = payload["artifact"]
    features = payload["features"]
    normalized = [
        (features[name] - artifact["preprocessing"]["means"][index])
        / artifact["preprocessing"]["scales"][index]
        for index, name in enumerate(artifact["featureNames"])
    ]
    raw = sigmoid(
        artifact["model"]["intercept"]
        + sum(
            coefficient * value
            for coefficient, value in zip(
                artifact["model"]["coefficients"], normalized
            )
        )
    )
    calibrator = artifact["calibrator"]
    logit = math.log(max(1e-12, raw) / max(1e-12, 1 - raw))
    calibrated = sigmoid(calibrator["slope"] * logit + calibrator["intercept"])
    hash_input = {
        key: value
        for key, value in artifact.items()
        if key != "artifactHash"
    }
    canonical = json.dumps(
        hash_input, sort_keys=True, separators=(",", ":")
    )
    return {
        "rawUp": raw,
        "calibratedUp": calibrated,
        "artifactHash": hashlib.sha256(canonical.encode()).hexdigest(),
    }


if __name__ == "__main__":
    print(json.dumps(evaluate(json.load(sys.stdin))))
