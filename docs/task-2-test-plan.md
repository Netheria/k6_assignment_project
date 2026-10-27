# Task 2 - Performance Analysis and Test Strategy

## 1. Objective

Design two complementary performance tests to investigate whether increased upload demand causes normal, recoverable resource pressure or exposes a performance regression.

- **Upload burst and recovery (stress and resilience):** assess how the service behaves when many upload requests arrive within a short period, and whether it recovers after the burst.
- **Endurance/soak:** assess whether memory usage and service performance stabilize under sustained load, or progressively deteriorate over time.

The tests must produce measurable evidence of upload correctness, memory behavior, service availability, and recovery to support the investigation.

## 2. Assumptions and scope

To make the hypothetical scenario testable, this plan adopts the following assumptions:

- **Service behavior:** The catalog-like application exposes an upload API. A successful upload can be verified through the API response and the presence of the uploaded artifact.
- **Workload cause under investigation:** The primary hypothesis is that increased concurrency in application-side request processing or pending work causes memory pressure. The test does not deliberately stress network bandwidth or storage throughput.
- **Upload data:** Every request carries a valid 256 KiB artifact of the same format, with a unique identifier. This keeps payload size and format constant so that request concurrency is the primary workload variable.
- **Clients:** Each client is already authenticated and submits one upload per iteration. Account creation and authentication performance are outside the test scope.
- **Resource capacity:** The environment has sufficient network and storage capacity for the defined workload. The application’s memory usage, pending work, and restart behavior are the primary resource concerns.
- **Test environment:** Tests run in an isolated environment with sufficient storage for the uploaded artifacts. Test data is retained during measurements and cleaned up afterwards.

These assumptions deliberately narrow the investigation and to not bloat the possible scope.

The tests can identify abnormal memory growth, queue accumulation, failed uploads, unexpected restarts, and poor recovery.

They do not independently prove the root cause; application logs and resource data would be used to investigate the observed behavior.

## 2.1 Test - Upload burst and recovery (stress and resilience)

**Objective:** Determine whether the service can handle a sudden increase in upload demand without unacceptable failures, unexpected restarts, or prolonged recovery.

### Workload, test data, and duration

| Element        | Proposed profile                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Baseline       | 10 minutes at the normal arrival rate \(R\)                                                           |
| Burst          | Increase from \(R\) to \(5 \* R\) within 10 seconds and maintain the burst for 5 minutes              |
| Recovery       | Return to \(R\) for up to 15 minutes while monitoring outstanding work and resource stabilization     |
| Concurrency    | Allow uploads to overlap naturally at the specified arrival rate; record actual in-flight concurrency |
| Test data      | Valid, unique uploads using the same representative payload profile throughout the run                |
| Total duration | Approximately 30 minutes, including baseline, burst, and recovery                                     |

The 5x rate and durations are illustrative. Preferably, in this case, to use a known real release peak or an agreed stress level.

If \(R\) is unknown, it can be established through a short baseline run or productiction env investigation before defining the "burst".

### Metrics

- **Functional and client:** upload attempts, verified successes, failures by status/category, timeouts, throughput, and latency p50/p95/p99.
- **Application and infrastructure:** process/container memory and limit utilization, CPU, restart/OOM-kill events, queue depth and age, and upload-processing time.
- **Diagnostic dependencies:** network errors/latency and storage/database errors/latency where available.
- **Recovery:** time for outstanding work to drain, memory and duration to stabilize, and latency/error rates to return towards baseline.

### Proposed pass/fail criteria

- No unexpected restart or OOM kill.
- At least 99% of valid upload attempts succeed. This is a provisional starting threshold, and every failure and timeout must be accounted for.
- Latency remains within the agreed SLO. Without an SLO, flag material degradation against baseline for investigation.
- Queue depth does not grow without bound and returns to a stable level within the agreed recovery window. Ten minutes is a proposed initial target if accepted by the service owner.
- Memory remains within the agreed safe operating margin and stabilizes during recovery. Eighty percent of the configured memory limit can be used as a provisional warning threshold, not a universal pass/fail boundary.

Interpret memory alongside live-set/heap metrics where available, restart events, and recovery behavior. RSS does not necessarily return exactly to its original value.

Without an established SLO, observed changes should be compared against against baseline instead of goals invetion.

### Example finding and recommendation

**Finding:** During the burst, container memory reached 92% of its limit and one unexpected restart occurred. Upload success fell below the provisional target. After the workload returned to \(R\), the queue took 12 minutes to drain.

**Meaning:** The service did not meet the proposed availability and recovery criteria under the burst workload. This indicates a potential stress/resilience issue, but does not identify whether the cause is application memory retention, queue configuration, or a dependency bottleneck.

**Recommendation:** Correlate the restart timestamp with application logs, queue depth, container events, and storage/database metrics. Investigate concurrent request processing, request buffering, queue limits, and retry behavior. Repeat the same workload after a targeted fix and compare the results.

## 2.2 Test - Endurance/soak

**Objective:** Determine whether memory and service behavior stabilize under sustained, representative upload traffic or progressively deteriorate over time.

This test uses the same upload operation and controlled data as Test 2.1, but removes the burst.

Its purpose is to identify slow memory growth, resource retention, accumulating work, or gradual performance degradation.

### Workload, test data, and duration

| Element        | Proposed profile                                                                       |
| -------------- | -------------------------------------------------------------------------------------- |
| Warm-up        | 30 minutes at the normal arrival rate \(R\)                                            |
| Steady phase   | 8 hours at \(R\); do not sustain the burst rate unless it represents normal operation  |
| Recovery       | 30 minutes after new uploads stop                                                      |
| Test data      | The same valid payload profile, with unique uploads; confirm adequate storage capacity |
| Total duration | Approximately 9 hours                                                                  |

A four-hour initial screening run is possible, but slower trends may remain undetected.

\(R\) should be derived from representative traffic or a baseline test.

Multiplication of duration from another test (like Load) may provide misleading results.

### Metrics

- Upload attempts, verified successes, errors/timeouts, throughput, and p50/p95/p99 latency over time.
- Memory/working set and memory-limit utilization as time series; post-GC heap/live-set where available.
- CPU, restart/OOM-kill events, and garbage-collection behavior where available.
- Queue depth/age and processing time to determine whether work accumulates.
- Recovery after uploads stop, including queue drain and memory stabilization.

### Proposed pass/fail criteria

- No unexpected restarts or OOM kills during steady load.
- At least 99% of valid uploads succeed, provisionally, and latency remains within agreed objectives.
- Memory stabilizes after warm-up and does not show sustained growth that threatens the configured limit. Use post-GC heap/live-set or equivalent evidence where available; RSS alone is not proof of a memory leak.
- Queue depth does not show a sustained upward trend, and latency/errors do not progressively deteriorate. Compare the first stable hour with the final stable hour; a p95 increase greater than 20% is a provisional investigation trigger, not an SLA unless formally agreed.
- After the workload stops, outstanding work drains and resources stabilize within the agreed recovery window.

If resource limits and SLOs are unknown, numeric thresholds should be marked/documented as provisional.

If suitable profiling metrics are unavailable, then continuing memory trend (a gradual, slow one) shouldn't be reported as a confirmed memory leak but as a suspected regression requiring investigation.

### Example finding and recommendation

**Finding:** No restarts occurred during the soak and upload success remained above the provisional target. However, post-GC live-set memory continued to increase throughout the steady phase, and p95 latency in the final stable hour was 35% higher than in the first stable hour.

**Meaning:** The service remained available, but the live-set trend and latency degradation are inconsistent with stable long-running behavior. They suggest possible resource retention or accumulating work, but do not by themselves prove a memory leak.

**Recommendation:** Compare the same test against the previous release. Correlate memory growth with completed upload count, queue depth, garbage collection, and application logs. Capture a heap/allocation profile if supported, inspect cleanup of upload buffers and retained metadata, and repeat the soak after changes.

## 3. Reporting findings to stakeholders

The same test evidence should be presented differently depending on the audience.

### QA, release, and other non-specialist stakeholders

Provide a concise summary of:

- What was tested and under which workload.
- Whether each acceptance criterion passed or failed.
- The principal finding and its practical meaning, such as unexpected restarts, failed uploads, or a possible long-term memory-growth risk.
- The effect on release risk and the recommended next action and owner.

Unexplained infrastructure graphs or raw metric charts should be avoided.

Suspected issue should be clearly distinguished from a confirmed root cause.

### Developers and service engineers

Provide aggregated time-aligned charts and a compact results table showing upload rate, latency/error rate, memory/limit utilization, queue depth, and restart/OOM events. Mark the baseline, burst, recovery, and soak phases. Include relevant informative logs, build/version, workload configuration, data profile, and reproduction steps.

Recommendations should point to the next investigation, such as correlating queue growth with memory use, checking resource cleanup, or capturing heap/allocation evidence.

## 4. Interpretation guide

- **Consistent with recoverable load pressure:** Memory rises during the burst but stabilizes, no unexpected restart occurs, upload correctness and latency remain acceptable, and outstanding work drains.
- **Potential burst/resilience regression:** Upload failures, an unexpected restart/OOM kill, unbounded queue growth, or failure to recover after the burst.
- **Potential endurance regression:** Memory/live-set continues to grow after warm-up, queue depth accumulates, latency/errors worsen over time, or the service restarts under steady representative load.

These patterns guide further investigation; they do not establish root cause on their own. Use dependency metrics and logs to verify whether network or storage behavior contributed, even though the primary test focus is application-side concurrency, memory, and recovery.
