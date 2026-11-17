"""CLI Evaluation Runner for First Milestones (`live-http` and `local-asgi`).

Usage examples:
  # Live Cloud Run baseline
  PYTHONPATH=agent uv run --python 3.12 --with-requirements agent/requirements.txt --with httpx \\
    python agent/eval/evaluate_agent.py \\
      --target live-http \\
      --base-url https://first-milestones-triage-ui-591261081648.us-central1.run.app \\
      --output /path/to/eval_baseline.json

  # Local in-process FastAPI ASGI smoke/regression check
  PYTHONPATH=agent uv run --python 3.12 --with-requirements agent/requirements.txt --with httpx \\
    python agent/eval/evaluate_agent.py --target local-asgi --output /path/to/local_eval.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from eval.adk_bridge import DEFAULT_GOLDEN_EVALSET_PATH, export_adk_evalset, load_golden_evalset  # noqa: E402
from eval.graders import (  # noqa: E402
    evaluate_case,
    get_oracle_context,
    grade_state_consistency,
    summarize_evaluation,
)


async def _post_chat(
    client: httpx.AsyncClient,
    message: str,
    state_code: str,
    session_id: str,
) -> tuple[dict[str, Any], float, str | None]:
    """Sends a single `POST /api/chat` request and returns `(payload, latency_ms, error)`."""
    t0 = time.perf_counter()
    try:
        resp = await client.post(
            "/api/chat",
            json={
                "message": message,
                "state_code": state_code,
                "session_id": session_id,
            },
        )
        latency_ms = (time.perf_counter() - t0) * 1000.0
        if resp.status_code != 200:
            return (
                {
                    "reply": "",
                    "tools_invoked": [],
                    "brief": {},
                    "model_used": None,
                    "fallback_used": False,
                },
                latency_ms,
                f"HTTP {resp.status_code}: {resp.text[:300]}",
            )
        return resp.json(), latency_ms, None
    except Exception as exc:  # noqa: BLE001
        latency_ms = (time.perf_counter() - t0) * 1000.0
        return (
            {
                "reply": "",
                "tools_invoked": [],
                "brief": {},
                "model_used": None,
                "fallback_used": False,
            },
            latency_ms,
            f"{type(exc).__name__}: {exc}",
        )


async def run_concurrency_state_isolation_probe(
    client: httpx.AsyncClient,
    run_id: str,
) -> dict[str, Any]:
    """Fires 4 parallel MS + CA `/api/chat` requests to stress-test state isolation."""
    probes = [
        {
            "probe_id": "concurrent_ms_1",
            "expected_state": "MS",
            "message": (
                "Route a 32-month-old toddler in tract 28049003500 (Mississippi) needing "
                "Medicaid Spanish-bilingual Autism screen without a vehicle."
            ),
        },
        {
            "probe_id": "concurrent_ca_1",
            "expected_state": "CA",
            "message": (
                "Route a 33-month-old toddler in tract 06047000801 (California) needing "
                "Medicaid Spanish-bilingual Autism screen without a vehicle."
            ),
        },
        {
            "probe_id": "concurrent_ms_2",
            "expected_state": "MS",
            "message": (
                "Audit >45-day multi-hop bounce hubs in Mississippi and check SYN-PROV-MS-011."
            ),
        },
        {
            "probe_id": "concurrent_ca_2",
            "expected_state": "CA",
            "message": (
                "Audit >45-day multi-hop bounce hubs in California and check SYN-PROV-CA-011."
            ),
        },
    ]

    async def _run_one(spec: dict[str, str]) -> dict[str, Any]:
        payload, latency_ms, err = await _post_chat(
            client,
            message=spec["message"],
            state_code=spec["expected_state"],
            session_id=f"iso-{run_id}-{spec['probe_id']}",
        )
        consistency = grade_state_consistency(
            reply=str(payload.get("reply", "")),
            brief=payload.get("brief"),
            expected_state=spec["expected_state"],
        )
        if err:
            consistency["passed"] = False
            consistency["failures"].append(err)
        brief = payload.get("brief") or {}
        return {
            "probe_id": spec["probe_id"],
            "expected_state": spec["expected_state"],
            "observed_brief_state": brief.get("state_code"),
            "observed_tract": ((brief.get("routing") or {}).get("child_profile") or {}).get(
                "home_tract_geoid"
            ),
            "model_used": payload.get("model_used"),
            "fallback_used": bool(payload.get("fallback_used", False)),
            "latency_ms": round(latency_ms, 1),
            "passed": consistency["passed"],
            "failures": consistency["failures"],
            "error": err,
        }

    results = await asyncio.gather(*(_run_one(p) for p in probes))
    passed_count = sum(1 for r in results if r["passed"])
    return {
        "total_concurrent_requests": len(results),
        "passed_requests": passed_count,
        "isolation_passed": passed_count == len(results),
        "probes": results,
    }


async def evaluate_suite(
    *,
    target: str,
    base_url: str = "",
    evalset_path: str | Path = DEFAULT_GOLDEN_EVALSET_PATH,
    concurrency: int = 1,
    delay_seconds: float = 0.5,
    timeout_seconds: float = 240.0,
    categories: list[str] | None = None,
    case_ids: list[str] | None = None,
    run_concurrency_probe: bool = True,
) -> dict[str, Any]:
    """Executes the golden evalset against `live-http` or `local-asgi`."""
    golden = load_golden_evalset(evalset_path)
    cases = list(golden["cases"])
    if categories:
        cat_set = {c.strip() for c in categories if c.strip()}
        cases = [c for c in cases if c["category"] in cat_set]
    if case_ids:
        id_set = {i.strip() for i in case_ids if i.strip()}
        cases = [c for c in cases if c["case_id"] in id_set]

    # Pre-warm oracle caches for states in evalset
    for st in sorted({str(c.get("state_code", "MS")).upper() for c in cases}):
        get_oracle_context(st)

    run_id = uuid.uuid4().hex[:8]

    if target == "local-asgi":
        from main import app  # local import so live-http doesn't require FastAPI startup unless needed

        transport = httpx.ASGITransport(app=app)
        client_ctx = httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            timeout=timeout_seconds,
        )
    elif target == "live-http":
        if not base_url:
            raise ValueError("--base-url is required when --target live-http")
        client_ctx = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout_seconds,
        )
    else:
        raise ValueError(f"Unsupported target={target!r}; expected 'live-http' or 'local-asgi'.")

    async with client_ctx as client:
        try:
            health_resp = await client.get("/api/health")
            health_info = health_resp.json() if health_resp.status_code == 200 else {
                "status_code": health_resp.status_code
            }
        except Exception as exc:  # noqa: BLE001
            health_info = {"error": f"{type(exc).__name__}: {exc}"}

        sem = asyncio.Semaphore(max(1, int(concurrency)))
        case_results: list[dict[str, Any]] = []

        async def _eval_one(idx: int, case: dict[str, Any]) -> dict[str, Any]:
            async with sem:
                if idx > 0 and delay_seconds > 0:
                    await asyncio.sleep(delay_seconds)
                st = str(case.get("state_code", "MS")).upper()
                session_id = f"eval-{run_id}-{case['case_id']}"
                payload, latency_ms, err = await _post_chat(
                    client,
                    message=case["prompt"],
                    state_code=st,
                    session_id=session_id,
                )
                oracle = get_oracle_context(st)
                result = evaluate_case(
                    case,
                    payload,
                    latency_ms=latency_ms,
                    oracle=oracle,
                )
                result["request_error"] = err
                result["reply_preview"] = str(payload.get("reply", ""))[:400]
                if err:
                    result["passed"] = False
                return result

        if concurrency <= 1:
            for idx, case in enumerate(cases):
                res = await _eval_one(idx, case)
                case_results.append(res)
                status_lbl = "PASS" if res["passed"] else "FAIL"
                print(
                    f"[{idx + 1:02d}/{len(cases):02d}] {status_lbl} {res['case_id']} "
                    f"(score={res['composite_score']:.2f}, traj_f1={res['trajectory']['f1']:.2f}, "
                    f"faith={res['faithfulness']['score']:.2f}, model={res['model_used']}, "
                    f"{res['latency_ms']:.0f}ms)",
                    flush=True,
                )
        else:
            # Batch by state_code when concurrency > 1 so main.py's process-wide A4I_STATE
            # does not cross-contaminate regular cases (reserved for the MS+CA probe).
            results_by_id: dict[str, dict[str, Any]] = {}
            completed = 0
            states_order = list(dict.fromkeys(str(c.get("state_code", "MS")).upper() for c in cases))
            for st in states_order:
                st_cases = [c for c in cases if str(c.get("state_code", "MS")).upper() == st]

                async def _eval_and_log(idx_in_batch: int, c: dict[str, Any]) -> dict[str, Any]:
                    nonlocal completed
                    res = await _eval_one(idx_in_batch, c)
                    completed += 1
                    status_lbl = "PASS" if res["passed"] else "FAIL"
                    print(
                        f"[{completed:02d}/{len(cases):02d}] {status_lbl} {res['case_id']} "
                        f"(score={res['composite_score']:.2f}, traj_f1={res['trajectory']['f1']:.2f}, "
                        f"faith={res['faithfulness']['score']:.2f}, model={res['model_used']}, "
                        f"{res['latency_ms']:.0f}ms)",
                        flush=True,
                    )
                    return res

                batch_results = await asyncio.gather(
                    *(_eval_and_log(i, c) for i, c in enumerate(st_cases))
                )
                for res in batch_results:
                    results_by_id[res["case_id"]] = res
            case_results = [results_by_id[c["case_id"]] for c in cases]

        isolation_probe = (
            await run_concurrency_state_isolation_probe(client, run_id)
            if run_concurrency_probe
            else None
        )

    summary = summarize_evaluation(case_results)
    return {
        "metadata": {
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "target": target,
            "base_url": base_url if target == "live-http" else "http://testserver (ASGI)",
            "evalset_id": golden.get("eval_set_id"),
            "concurrency": concurrency,
            "run_id": run_id,
        },
        "health": health_info,
        "summary": summary,
        "state_isolation_stress_test": isolation_probe,
        "cases": case_results,
    }


def print_scorecard(report: dict[str, Any]) -> None:
    """Prints a human-readable scorecard summary to stdout."""
    s = report["summary"]
    meta = report["metadata"]
    print("\n" + "=" * 78)
    print(f"FIRST MILESTONES AGENT EVAL SCORECARD ({meta['target']} -> {meta['base_url']})")
    print("=" * 78)
    print(
        f"Cases Passed: {s['passed_cases']}/{s['total_cases']} ({s['case_pass_rate'] * 100:.1f}%) | "
        f"Mean Composite Score: {s['mean_composite_score']:.3f}"
    )
    tm = s["trajectory_metrics"]
    print(
        f"Trajectory:   P={tm['mean_precision']:.3f} R={tm['mean_recall']:.3f} F1={tm['mean_f1']:.3f} "
        f"Score={tm['mean_score']:.3f} | Pass={tm['trajectory_pass_rate'] * 100:.1f}% | "
        f"Shortcut={tm['brief_shortcut_rate'] * 100:.1f}% | EquityAudit={tm['equity_audit_presence_rate'] * 100:.1f}%"
    )
    fm = s["faithfulness_metrics"]
    print(
        f"Faithfulness: Mean={fm['mean_score']:.3f} | Pass={fm['faithfulness_pass_rate'] * 100:.1f}%"
    )
    cm = s["clinical_statutory_metrics"]
    print(
        f"Clinical/310: Mean={cm['mean_score']:.3f} | Pass={cm['clinical_statutory_pass_rate'] * 100:.1f}%"
    )
    gm = s["guardrail_metrics"]
    print(
        f"4-Pillar GR:  Mean={gm['mean_score']:.3f} | Pass={gm['guardrail_pass_rate'] * 100:.1f}% | "
        f"Pillars={gm['pillar_pass_rates']}"
    )
    lat = s["latency_ms"]
    print(
        f"Runtime:      FallbackRate={s['fallback_used_rate'] * 100:.1f}% | "
        f"P50={lat['p50']:.0f}ms P95={lat['p95']:.0f}ms | Models={s['model_breakdown']}"
    )
    iso = report.get("state_isolation_stress_test")
    if iso:
        print(
            f"MS+CA Probe:  {iso['passed_requests']}/{iso['total_concurrent_requests']} passed "
            f"(isolation_passed={iso['isolation_passed']})"
        )
        for p in iso["probes"]:
            if not p["passed"]:
                print(f"  - PROBE FAIL {p['probe_id']}: {p['failures']}")
    print("\nCategory Breakdown:")
    for cat, stats in s["by_category"].items():
        print(
            f"  - {cat:24s}: {stats['passed']}/{stats['total']} passed "
            f"({stats['pass_rate'] * 100:.1f}%), composite={stats['mean_composite_score']:.3f}"
        )
    failed_cases = [c for c in report["cases"] if not c["passed"]]
    if failed_cases:
        print("\nFailed Cases Diagnostics:")
        for c in failed_cases:
            reasons: list[str] = []
            if c.get("request_error"):
                reasons.append(f"error={c['request_error']}")
            if not c["trajectory"]["passed"]:
                reasons.append(
                    f"traj(missing={c['trajectory']['missing_required_tools']}, anti={c['trajectory']['anti_patterns']})"
                )
            if not c["faithfulness"]["passed"]:
                reasons.append(
                    f"faith(ungrounded_ent={c['faithfulness']['ungrounded_entities']}, "
                    f"state_mismatch={c['faithfulness']['state_mismatched_entities']}, "
                    f"wait_mismatch={c['faithfulness']['mismatched_wait_days']}, "
                    f"ungrounded_wait={c['faithfulness']['ungrounded_wait_days']}, "
                    f"ungrounded_breach={c['faithfulness']['ungrounded_breach_counts']}, "
                    f"ungrounded_pct={c['faithfulness']['ungrounded_percentages']})"
                )
            if not c["clinical_statutory"]["passed"]:
                reasons.append(f"clin({c['clinical_statutory']['failures']})")
            if not c["guardrails"]["passed"]:
                reasons.append(f"guard({c['guardrails']['failures']})")
            if not c["state_consistency"]["passed"]:
                reasons.append(f"state({c['state_consistency']['failures']})")
            print(f"  * {c['case_id']}: " + "; ".join(reasons))
    print("=" * 78 + "\n")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="First Milestones Agent Evaluation Suite Runner")
    parser.add_argument(
        "--target",
        choices=("live-http", "local-asgi"),
        default="local-asgi",
        help="Evaluation target: deployed Cloud Run HTTP endpoint or in-process FastAPI ASGI.",
    )
    parser.add_argument(
        "--base-url",
        default="https://first-milestones-triage-ui-591261081648.us-central1.run.app",
        help="Base URL when --target live-http is selected.",
    )
    parser.add_argument(
        "--evalset",
        default=str(DEFAULT_GOLDEN_EVALSET_PATH),
        help="Path to golden_evalset.json.",
    )
    parser.add_argument("--concurrency", type=int, default=1, help="Max concurrent eval requests.")
    parser.add_argument(
        "--delay-seconds",
        type=float,
        default=None,
        help="Pause between sequential requests (defaults to 0.5s for live-http, 0.0s for local-asgi).",
    )
    parser.add_argument("--timeout-seconds", type=float, default=240.0)
    parser.add_argument("--categories", nargs="*", default=None)
    parser.add_argument("--case-ids", nargs="*", default=None)
    parser.add_argument("--skip-concurrency-probe", action="store_true")
    parser.add_argument("--output", default="", help="Optional path to save JSON evaluation report.")
    parser.add_argument("--adk-export", default="", help="Optional path to export ADK .evalset.json.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.adk_export:
        adk_path = export_adk_evalset(args.adk_export, args.evalset)
        print(f"Exported ADK EvalSet to {adk_path}")

    delay = args.delay_seconds
    if delay is None:
        delay = 0.5 if args.target == "live-http" else 0.0

    report = asyncio.run(
        evaluate_suite(
            target=args.target,
            base_url=args.base_url,
            evalset_path=args.evalset,
            concurrency=args.concurrency,
            delay_seconds=delay,
            timeout_seconds=args.timeout_seconds,
            categories=args.categories,
            case_ids=args.case_ids,
            run_concurrency_probe=not args.skip_concurrency_probe,
        )
    )
    print_scorecard(report)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Saved JSON report to {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
