# Task 1 - Execution Report

**Run date:** 27 October 2026  
**Environment:** KNIME candidate Hub environment  
**Workflow:** `01 Analyze Data by Training a Decision Tree`  
**Execution mode:** Ad-Hoc

## Test setup

- **Load:** 100 virtual users, one workflow-execution request per user.
- Authentication and workflow navigation were performed during setup; the concurrent workload submitted the execution requests.
- The 100 submission starts were recorded within a **5 ms spread**.

## Results

| Measurement                      |               Result |
| -------------------------------- | -------------------: |
| Configured virtual users         |                  100 |
| Execution attempts               |                  100 |
| Jobs created                     |                  100 |
| Workflows completed successfully |              **100** |
| Workflow failures observed       |                **0** |
| Unknown workflow outcomes        |                **0** |
| HTTP requests                    |                1,015 |
| HTTP request failure rate        |            **0.00%** |
| k6 checks                        | 500 passed, 0 failed |
| Total k6 run duration            |              31.97 s |

All 100 job-creation requests returned HTTP `201`. The recorded final workflow state for each execution was `EXECUTION_FINISHED`.

### Timing

| Measurement                           |  Median |     p95 | Maximum |
| ------------------------------------- | ------: | ------: | ------: |
| Workflow submission request           |  9.28 s | 15.28 s | 21.27 s |
| Submission to observed terminal state | 24.92 s | 27.13 s | 27.83 s |

The second timing includes status observation through polling; it is **not** a precise measurement of the workflow engine's internal execution time.

## Conclusion

In this run, all 100 concurrent Ad-Hoc execution requests created jobs and all 100 workflows were observed in the successful terminal state. No HTTP request failures or failed k6 checks were recorded. The measured submission-start spread was 5 ms, meeting the intended near-simultaneous request pattern.

This is evidence of one successful run, not a capacity limit or an SLA benchmark. Server-side CPU, memory, and other infrastructure metrics were not collected.

**Run history note:** An earlier attempt reportedly created 80 jobs and encountered HTTP request errors. Its detailed results were not retained, so the cause cannot be determined from the available evidence and those results are not included in the measurements above.

## Evidence

- [`results/console.log`](../results/console.log) - k6 console output and per-execution outcome records.
- [`results/summary.json`](../results/summary.json) - aggregate k6 metrics and checks. The shared copy has censored authentication token.
