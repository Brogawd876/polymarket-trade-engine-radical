# Offline model research

This package is intentionally separate from the Bun trading runtime. It reads
immutable candidate-level JSONL data, keeps every market in one chronological
partition, selects a model on the policy partition, evaluates the selected
model once on the final partition, and exports an unapproved frozen artifact.

The live runtime never trains models and refuses unapproved, expired,
incompatible, or hash-invalid artifacts.

Run:

```powershell
python -m unittest discover -s research_pipeline/tests
python research_pipeline/pipeline.py --input candidates.ndjson --output artifacts
```
