# Validation and realism — what the numbers mean

This document separates seven things that are easy to conflate. The Social World
computes some of them and deliberately refuses to compute others.

| # | Concept | Computed? | Where |
|---|---------|-----------|-------|
| 1 | Simulation realism | Partly — as *configuration quality* | Quality tab |
| 2 | Internal consistency | Yes — counted from recorded rows | Quality tab, Findings |
| 3 | Evidence traceability | Yes — chunk/page citations per post | Findings, Source drawer |
| 4 | Behavioural plausibility | No — heuristics are not calibrated | Stated as a limitation |
| 5 | Stability across repeated simulations | Not automated — manual comparison | Compare runs |
| 6 | External validation | Infrastructure only, no dataset | Quality → Validation |
| 7 | Actual predictive accuracy | **No** | Not claimed anywhere |

## The one-sentence rule

> **Predictive accuracy has not yet been externally validated.**

That sentence appears verbatim in the report, in the Quality tab and here. It must
not be softened or removed while no observed dataset is linked to a run.

## Simulation Quality ≠ predictive accuracy

`backend/app/analytics/realism.py` returns a 0–100 **weighted average of assessed
dimensions**. It answers: *is this simulation well-configured and internally
consistent enough to be worth reading?*

It does **not** answer: *does this simulation predict the real world?*

The API response states this in `overall.method`, and `predictive_accuracy` is
always one of:

- `status: "not_validated"` — no observations linked (the normal case); message:
  *"The Social World does not claim predictive accuracy for real-world opinion or
  behaviour."*
- `status: "data_connected"` — observations exist, but accuracy is still not
  computed; a proper evaluation must be designed explicitly.

Each response also carries a `summary` block used by the Quality tab:

- `headline` — one sentence describing the overall state of the run
- `strong` — dimensions scoring 75+
- `attention` — dimensions scoring below 60
- `not_assessed` — dimensions with no usable data, each with `requires`
- `actions` — ordered, concrete recommendations with the change and what it
  would make measurable

## The narrative layer

`backend/app/analytics/narrative.py` produces the Findings briefing. It reads
`agents`, `stance_history`, `posts`, `stance_changes`, `edges` and `chunks` and
composes sentences **by rule**. It makes no model call, which is why the UI can
label it "Computed, not generated".

It returns:

- `answers` — short prose answers to the reader's eight questions
- `key_findings` — 1–5 findings, each with a headline, explanation, supporting
  data, affected issues/groups/agents, evidence chunks, a `strength` label
  (`strong` / `moderate` / `indicative`) and a `why_it_matters` sentence
- `issues` — one section per configured issue: initial vs final landscape,
  supporters/opponents/undecided, movement, triggers, evidence, top agents
- `stakeholders` — one section per configured group: start/end position,
  movement, priority issues, concerns, representatives, network role
- `timeline` — stance changes of 0.25 or more
- `uncertainty` — explicit caveats, always including the persona limitation

`strength` is a strength-of-evidence label derived from sample size and stance
spread. The response says so: *"This is a strength-of-evidence label, not a
probability."*

## The report

`backend/app/analytics/report_doc.py` renders the written deliverable from the
same counted rows plus the narrative. Sections: cover, executive summary,
scenario, methodology, stakeholder landscape, issue landscape, findings, issue
analysis, stakeholder analysis, network dynamics, evidence, changes over time,
outliers, uncertainty, validation, limitations, implications, appendix.

Every number is counted. The interpretive sentences come from the rule-based
narrative. The only generated element is the optional LLM executive-summary
draft, stored and labelled separately.

## Dimensions and how each is counted

Every dimension carries `status`, `score`, `explanation` and `evidence`. A
dimension with no usable data returns `score: null` — never a guessed number.

| id | Group | Counted from |
|----|-------|--------------|
| `evidence_coverage` | Evidence | posts with `cited_chunk_ids_json` ÷ posts; distinct cited chunks |
| `evidence_quality` | Evidence | *not assessed* — no source-quality labels |
| `agent_diversity` | Population | distinct `archetypes` ÷ target; distinct groups |
| `issue_coverage` | Population | issues present in `stance_history` ÷ configured issues |
| `stakeholder_representation` | Population | groups with ≥1 agent ÷ configured groups |
| `population_representation` | Population | explicit `population_weight` on every group |
| `persona_grounding` | Behaviour | agents with a belief summary **and** knowledge chunks |
| `behavioural_calibration` | Behaviour | *not assessed* — heuristics, not fitted |
| `starting_stance_calibration` | Behaviour | *not assessed* — no survey baseline |
| `information_exposure` | Behaviour | *not assessed* — exposure events not stored |
| `interaction_realism` | Network | edges and replies per agent |
| `network_realism` | Network | density vs a sparse-graph target |
| `temporal_realism` | Temporal | completed rounds ÷ configured rounds |
| `stance_stability` | Temporal | mean start-to-end \|Δstance\| from `stance_history` |
| `event_realism` | Temporal | intervention rows (scenario choice, not quality) |
| `provider_reliability` | Configuration | successful `llm_calls` ÷ attempted |
| `generation_quality` | Configuration | `parsed_ok` ÷ successful calls |
| `configuration_completeness` | Configuration | manifest fields present |
| `data_completeness` | Configuration | which record layers exist |
| `replication_stability` | Robustness | *manual* — needs a second run to compare |
| `sensitivity_analysis` | Robustness | *not implemented* |
| `historical_validation` | Validation | linked `validation_observations` (MAE shown, no accuracy claim) |
| `outcome_validation` | Validation | *not connected* — no observed outcome |

`stance_stability` measures **persistence, not correctness**. A frozen population
scores 100; that is a fact about the simulation, not a virtue.

`provider_reliability` and `generation_quality` describe the transport and the
machine-validity of model output. They say nothing about whether the prose is true.

## Adding external validation

The schema already exists:

```sql
validation_datasets(id, name, kind, source, notes, data_json, created_at)
validation_observations(id, dataset_id, run_id, metric, predicted, observed, error, created_at)
```

API:

- `GET  /api/validation` — list datasets and observations
- `POST /api/validation/datasets` — register a dataset (name, kind, source, notes, data)
- `POST /api/validation/observations` — link one predicted/observed pair to a run;
  `error = predicted - observed`
- `GET  /api/runs/{id}/validation` — observations for one run

When observations exist, `historical_validation` becomes `partial` with a mean
absolute error in its evidence, and `predictive_accuracy.status` becomes
`data_connected`. **No single accuracy number is produced.** Metrics such as MAE,
RMSE, correlation, calibration and directional accuracy are not interchangeable and
must not be averaged into one headline figure.

### What a real evaluation would still need

1. An observed dataset with a documented population, sample size and method.
2. A matching simulated quantity for the *same* population and period.
3. An error metric chosen before looking at the result.
4. Reporting of uncertainty (confidence intervals where the source provides them).

Until all four exist, the honest status is: **external validation not available.**

## Reproducing the tests

```bash
cd backend
python -m pytest tests/test_pipeline_n.py -v
```

`test_quality_reports_honest_dimension_set` asserts that the required dimensions
exist, that unassessed dimensions never carry a score, and that the overall method
text says *"not predictive accuracy"*.
