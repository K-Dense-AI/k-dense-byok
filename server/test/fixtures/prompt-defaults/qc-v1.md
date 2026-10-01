---
description: Quality-control report for a dataset before any analysis
argument-hint: <file>
---

Run a quality-control pass on `$1` before any modelling. Do not modify the file.

1. Load it with the right reader for its format; report shape, column types and memory footprint.
2. Missing values per column (count and %), duplicated rows, constant columns, and obvious type problems (numbers stored as text, mixed date formats).
3. Numeric columns: range, mean/median, and outliers beyond 3 MAD; flag impossible values (negative counts, percentages over 100, dates in the future).
4. Categorical columns: cardinality and the top levels; flag near-duplicate spellings.
5. If the data has a design (samples × conditions, replicates, batches), check the design is balanced and every expected sample is present.

Write the report to `derived/qc_$1.md` (create `derived/` if needed), log the key findings in the lab notebook as an observation, and end with a short list of issues that must be resolved before analysis.
