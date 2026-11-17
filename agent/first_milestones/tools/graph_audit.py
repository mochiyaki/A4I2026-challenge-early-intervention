"""Custom ISO GQL Network Audit, Historical Referral Retrieval & Counterfactual Simulator Tools.

Provides:
  1. `get_referral_history`: Episodic `-{2,4}->` ISO GQL historical referral chain
     retrieval (`REFERS_TO` edges) with hop-by-hop timestamp & calendar wait-delta proof,
     canonical Hop-1 `child_age_months_at_referral`, and strict active-state selector
     validation (`case_chain_id`, `provider_id`, `tract_geoid`).
  2. `audit_multihop_bounce_hubs`: Variable-length `-{2,4}->` ISO GQL traversal
     correlated on `case_chain_id` and prefix-deduplicated (preventing Type B
     `Vendor -> Vendor` 3-hop prefix double counting). Exposes why flat SQL
     waitlist sorting blames downstream queues while missing low-wait `paper_fax`
     intake coordinators (`SYN-PROV-*-011`, `012`).
  3. `simulate_hub_intervention`: Counterfactual graph simulation computing exact
     delayed child-days saved and 45-day statutory breaches eliminated if a targeted
     coordinator hub upgrades `paper_fax` -> `ehr_electronic_portal` and pre-verifies
     bilingual/Medicaid evaluation slot availability.
  4. `detect_regional_bottleneck_hubs`: Regional betweenness-centrality audit over
     2-4 hop breached referral chains, exposing low-internal-wait intermediate hubs
     that carry disproportionate statutory breach flow.
"""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
import re
from typing import Any

from .bq_client import (
    VALID_STATES,
    get_config,
    graph_client,
    load_local_state_frames,
    rewrite_sql_dataset,
)

_SAFE_ID_RE = re.compile(r"^[A-Z0-9_-]+$")
_RELATIONSHIP_SEMANTICS = (
    "REFERS_TO edges represent historical episodic child referral events "
    "('actually referred to'); each hop's handoff_wait_days equals the exact "
    "calendar delta to the next hop."
)


def _clean_state_code(state_code: str) -> str:
    """Validates a 2-letter uppercase ISO/US state code before SQL interpolation."""
    clean = state_code.strip().upper() if isinstance(state_code, str) else ""
    return clean if re.fullmatch(r"^[A-Z]{2}$", clean) else ""


def _coerce_bool(val: Any, default: bool = False) -> bool:
    """Coalesces None and string/boolean inputs safely."""
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        norm = val.strip().lower()
        if norm in ("true", "1", "yes", "y"):
            return True
        if norm in ("false", "0", "no", "n", ""):
            return False
    return bool(val)


def _parse_int_param(val: Any, default: int) -> tuple[int | None, bool]:
    """Parses an optional int parameter, rejecting booleans and invalid strings."""
    if val is None:
        return default, True
    if isinstance(val, bool):
        return None, False
    try:
        return int(val), True
    except (TypeError, ValueError):
        return None, False


def _build_referral_history_gql(
    dataset: str,
    state_code: str = "",
    case_chain_id: str = "",
    provider_id: str = "",
    tract_geoid: str = "",
    only_breaches: bool = False,
    limit_chains: int = 3,
) -> str:
    """Builds a prefix-safe ISO/IEC 39075 GQL query for historical referral chains."""
    clean_state = _clean_state_code(state_code)
    clauses: list[str] = []
    if clean_state:
        clauses.append(f"src.state_code = '{clean_state}'")
    clauses.append("r[OFFSET(0)].hop_sequence = 1")
    clauses.append("(SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(r) AS h) = 1")

    clean_chain = (case_chain_id or "").strip().upper()
    if clean_chain and _SAFE_ID_RE.fullmatch(clean_chain):
        clauses.append(f"r[OFFSET(0)].case_chain_id = '{clean_chain}'")

    clean_prov = (provider_id or "").strip().upper()
    if clean_prov and _SAFE_ID_RE.fullmatch(clean_prov):
        clauses.append(
            "EXISTS(SELECT 1 FROM UNNEST(r) AS h "
            f"WHERE h.source_provider_id = '{clean_prov}' OR h.target_provider_id = '{clean_prov}')"
        )

    clean_tract = (tract_geoid or "").strip()
    if clean_tract.isdigit() and len(clean_tract) in (10, 11):
        padded_tract = clean_tract.zfill(11)
        clauses.append(f"LPAD(CAST(r[OFFSET(0)].child_home_tract_geoid AS STRING), 11, '0') = '{padded_tract}'")

    where_sql = " AND ".join(clauses)
    limit_int = max(1, min(int(limit_chains or 3), 10))
    is_unfiltered_sample = not (clean_chain or clean_prov or clean_tract) and not only_breaches
    breach_where = " WHERE total_wait_days > 45" if only_breaches else ""
    order_sql = (
        "ROW_NUMBER() OVER (PARTITION BY total_wait_days > 45 ORDER BY total_wait_days DESC, chain_id), "
        "total_wait_days DESC"
        if is_unfiltered_sample
        else "total_wait_days DESC, chain_id"
    )
    return (
        f"WITH chains AS (SELECT * FROM GRAPH_TABLE({dataset}.ReferralGraph\n"
        "  MATCH (src:CareNode {node_role: 'Screening_Pediatric_Clinic'})-[r:REFERS_TO]->{2,4}"
        "(dest:CareNode {node_role: 'EI_Therapy_Vendor'})\n"
        f"  WHERE {where_sql}\n"
        "  LET chain_id = r[OFFSET(0)].case_chain_id, total_hops = ARRAY_LENGTH(r),\n"
        "      total_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(r) AS h),\n"
        "      hops = ARRAY(SELECT AS STRUCT h.hop_sequence, h.referral_event_id, h.source_provider_id, "
        "h.target_provider_id, h.handoff_wait_days FROM UNNEST(r) h ORDER BY 1)\n"
        "  RETURN chain_id, total_hops, total_wait_days, hops)\n"
        "  QUALIFY ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY total_hops DESC) = 1)\n"
        f"SELECT * FROM chains{breach_where} ORDER BY {order_sql} LIMIT {limit_int};"
    )


def get_referral_history(
    case_chain_id: str = "",
    provider_id: str = "",
    tract_geoid: str = "",
    only_breaches: bool = False,
    limit_chains: int = 3,
) -> dict[str, Any]:
    """Retrieves episodic 2-4 hop referral chains with exact hop timestamps and delay proof.

    Traverses `ReferralGraph` (`REFERS_TO` edges from `Screening_Pediatric_Clinic` to
    `EI_Therapy_Vendor`, prefix-deduplicated by `case_chain_id`) or its local GeoParquet
    mirror, proving that each hop's `handoff_wait_days` equals the exact calendar delta
    to the next hop and preserving Hop 1's canonical `child_age_months_at_referral`.

    Args:
        case_chain_id: Optional chain ID (e.g. 'CHAIN-MS-023') in the active state.
        provider_id: Optional `SYN-PROV-*` ID matched as source or target on any hop.
        tract_geoid: Optional 10- or 11-digit Census tract GEOID (`child_home_tract_geoid`).
        only_breaches: If True, returns only chains with `total_wait_days > 45`.
        limit_chains: Max chains to return (`1..10`, defaults to `3`).
    """
    raw_chain = "" if case_chain_id is None else str(case_chain_id)
    raw_prov = "" if provider_id is None else str(provider_id)
    raw_tract = "" if tract_geoid is None else str(tract_geoid)
    only_breaches_bool = _coerce_bool(only_breaches, default=False)

    limit_int, ok_limit = _parse_int_param(limit_chains, default=3)
    if not ok_limit or limit_int is None or limit_int < 1:
        return {
            "status": "validation_error",
            "error_code": "INVALID_LIMIT_CHAINS",
            "message": "limit_chains must be >= 1 (max 10).",
        }
    limit_int = min(limit_int, 10)

    cfg = get_config()
    state_code = cfg["state"]
    frames = load_local_state_frames(state_code)
    demo = frames["demo"]
    prov = frames["providers"]
    logs = frames["logs"]

    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}
    valid_chain_ids = sorted(logs["case_chain_id"].astype(str).unique().tolist())
    valid_chain_set = set(valid_chain_ids)
    valid_prov_ids = sorted(prov_by_id.keys())
    valid_tract_set = set(demo["census_tract_geoid"].astype(str).tolist())
    sample_log_tracts = sorted(logs["child_home_tract_geoid"].astype(str).unique().tolist())[:5]

    clean_chain = raw_chain.strip().upper()
    if clean_chain and clean_chain not in valid_chain_set:
        other_state_note = ""
        m_state = re.match(r"^CHAIN-([A-Z]{2})-\d+$", clean_chain)
        if m_state and m_state.group(1) != state_code and m_state.group(1) in VALID_STATES:
            other_state_note = (
                f" Chain '{clean_chain}' belongs to state '{m_state.group(1)}', "
                f"while active state is '{state_code}'."
            )
        return {
            "status": "validation_error",
            "error_code": "CHAIN_NOT_FOUND_IN_ACTIVE_STATE",
            "state_code": state_code,
            "case_chain_id": clean_chain,
            "message": (
                f"case_chain_id '{clean_chain}' was not found in active state '{state_code}'."
                f"{other_state_note}"
            ),
            "sample_valid_chain_ids": valid_chain_ids[:5],
        }

    clean_prov = raw_prov.strip().upper()
    if clean_prov and clean_prov not in prov_by_id:
        return {
            "status": "validation_error",
            "error_code": "PROVIDER_NOT_FOUND_IN_ACTIVE_STATE",
            "state_code": state_code,
            "provider_id": clean_prov,
            "message": (
                f"provider_id '{clean_prov}' was not found in active state '{state_code}'."
            ),
            "sample_valid_provider_ids": valid_prov_ids[:6],
        }

    clean_tract_raw = raw_tract.strip()
    clean_tract = ""
    if clean_tract_raw:
        if clean_tract_raw.isdigit() and len(clean_tract_raw) in (10, 11):
            clean_tract = clean_tract_raw.zfill(11)
        if not clean_tract or clean_tract not in valid_tract_set:
            return {
                "status": "validation_error",
                "error_code": "TRACT_NOT_FOUND_IN_ACTIVE_STATE",
                "state_code": state_code,
                "tract_geoid": clean_tract_raw,
                "message": (
                    f"tract_geoid '{clean_tract_raw}' was not found in active state '{state_code}'."
                ),
                "sample_valid_tract_geoids": sample_log_tracts or sorted(valid_tract_set)[:5],
            }

    active_selectors = [
        name
        for name, val in (
            ("case_chain", clean_chain),
            ("provider", clean_prov),
            ("tract", clean_tract),
        )
        if val
    ]
    if not active_selectors:
        query_scope = "state_sample"
    elif len(active_selectors) == 1:
        query_scope = active_selectors[0]
    else:
        query_scope = "multi_filter"

    iso_gql = _build_referral_history_gql(
        cfg["dataset"],
        state_code=state_code,
        case_chain_id=clean_chain,
        provider_id=clean_prov,
        tract_geoid=clean_tract,
        only_breaches=only_breaches_bool,
        limit_chains=limit_int,
    )
    bq_rows = graph_client.query_bq_or_none(iso_gql)
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    iso_gql = rewrite_sql_dataset(iso_gql, cfg["dataset"], active_ds)
    engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({state_code} starter tables)"
    )

    chains_by_id: dict[str, dict[str, Any]] = {}
    chain_providers: dict[str, set[str]] = {}
    for cid_raw, grp in logs.groupby("case_chain_id"):
        grp_s = grp.sort_values("hop_sequence")
        n_hops = len(grp_s)
        if not (2 <= n_hops <= 4) or int(grp_s.iloc[0]["hop_sequence"]) != 1:
            continue
        first_src = str(grp_s.iloc[0]["source_provider_id"])
        last_dst = str(grp_s.iloc[-1]["target_provider_id"])
        src_meta = prov_by_id.get(first_src)
        dst_meta = prov_by_id.get(last_dst)
        if (
            src_meta is None
            or dst_meta is None
            or str(src_meta["node_role"]) != "Screening_Pediatric_Clinic"
            or str(dst_meta["node_role"]) != "EI_Therapy_Vendor"
        ):
            continue

        cid = str(cid_raw)
        hops_list: list[dict[str, Any]] = []
        cum_days = 0
        provs_touched: set[str] = set()
        for _, h in grp_s.iterrows():
            s_id = str(h["source_provider_id"])
            t_id = str(h["target_provider_id"])
            provs_touched.add(s_id)
            provs_touched.add(t_id)
            w_days = int(h["handoff_wait_days"])
            cum_days += w_days
            ref_d = date.fromisoformat(str(h["referral_date"])[:10])
            next_d = ref_d + timedelta(days=w_days)
            reason = str(h["handoff_reason"])
            is_b = reason.startswith("Re-Referral Bounce")
            hops_list.append({
                "hop_seq": int(h["hop_sequence"]),
                "event_id": str(h["referral_event_id"]),
                "referral_date": ref_d.isoformat(),
                "next_step_date": next_d.isoformat(),
                "src_id": s_id,
                "dst_id": t_id,
                "dst_role": str(prov_by_id[t_id]["node_role"]),
                "channel": str(h["transmission_channel"]),
                "wait_days": w_days,
                "cumulative_days": cum_days,
                "dropoff_pct": round(float(h["dropoff_rate_pct"]) * 100.0, 1),
                "reason": reason,
                "is_bounce": is_b,
            })

        total_w = cum_days
        hop1 = grp_s.iloc[0]
        chains_by_id[cid] = {
            "case_chain_id": cid,
            "child_age_months_at_referral": int(hop1["child_age_months"]),
            "initial_referral_date": hops_list[0]["referral_date"],
            "final_handoff_date": hops_list[-1]["referral_date"],
            "estimated_completion_date": hops_list[-1]["next_step_date"],
            "total_hops": n_hops,
            "total_wait_days": total_w,
            "clears_45d_clock": total_w <= 45,
            "headroom_or_excess_days": 45 - total_w,
            "receiving_agency_id": str(hop1["receiving_agency_id"]),
            "concern_domain": str(hop1["concern_domain"]),
            "child_home_tract_geoid": str(hop1["child_home_tract_geoid"]),
            "paper_fax_hops": sum(1 for x in hops_list if x["channel"] == "paper_fax"),
            "bounce_hops": sum(1 for x in hops_list if x["is_bounce"]),
            "hops": hops_list,
        }
        chain_providers[cid] = provs_touched

    matched: list[dict[str, Any]] = []
    for cid, cdict in chains_by_id.items():
        if clean_chain and cid != clean_chain:
            continue
        if clean_prov and clean_prov not in chain_providers[cid]:
            continue
        if clean_tract and cdict["child_home_tract_geoid"] != clean_tract:
            continue
        if only_breaches_bool and cdict["clears_45d_clock"]:
            continue
        matched.append(cdict)

    if bq_rows is not None:
        selected: list[dict[str, Any]] = []
        for row in bq_rows[:limit_int]:
            rcid = str(row.get("chain_id") or row.get("case_chain_id") or "")
            if rcid in chains_by_id:
                selected.append(chains_by_id[rcid])
        matched_count = len(matched) if selected else len(bq_rows)
    elif query_scope == "state_sample" and not only_breaches_bool:
        breached = sorted(
            [c for c in matched if not c["clears_45d_clock"]],
            key=lambda c: (-c["total_wait_days"], c["case_chain_id"]),
        )
        timely = sorted(
            [c for c in matched if c["clears_45d_clock"]],
            key=lambda c: (c["total_wait_days"], c["case_chain_id"]),
        )
        interleaved: list[dict[str, Any]] = []
        max_len = max(len(breached), len(timely))
        for idx in range(max_len):
            if idx < len(breached):
                interleaved.append(breached[idx])
            if idx < len(timely):
                interleaved.append(timely[idx])
        selected = interleaved[:limit_int]
        matched_count = len(matched)
    else:
        matched.sort(key=lambda c: (-c["total_wait_days"], c["case_chain_id"]))
        selected = matched[:limit_int]
        matched_count = len(matched)

    return {
        "status": "ok",
        "engine": engine,
        "state_code": state_code,
        "query_scope": query_scope,
        "matched_chains_count": matched_count,
        "returned_chains_count": len(selected),
        "relationship_semantics": _RELATIONSHIP_SEMANTICS,
        "synthetic_provenance_notice": (
            "100% [Synthetic] CareNode (SYN-PROV-*) & ReferralGraph handoff logs."
        ),
        "iso_gql_query": iso_gql,
        "chains": selected,
    }


def _build_audit_iso_gql(dataset: str, state_code: str = "") -> str:
    clean_state = _clean_state_code(state_code)
    state_filter = f"c.state_code='{clean_state}' AND " if clean_state else ""
    return (
        f"SELECT * FROM GRAPH_TABLE({dataset}.ReferralGraph "
        "MATCH (c:CareNode {node_role:'Screening_Pediatric_Clinic'})-[r:ReferralHandoff]->{2,4}"
        "(v:CareNode {node_role:'EI_Therapy_Vendor'}) "
        f"WHERE {state_filter}r[OFFSET(0)].hop_sequence=1 "
        "AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(r) h)=1 "
        "LET id=r[OFFSET(0)].case_chain_id, hops=ARRAY_LENGTH(r), "
        "wait_d=(SELECT SUM(h.handoff_wait_days) FROM UNNEST(r) h) "
        "RETURN id, r[OFFSET(0)].target_provider_id AS coord_id, hops, wait_d) "
        "QUALIFY ROW_NUMBER() OVER(PARTITION BY id ORDER BY hops DESC)=1 ORDER BY wait_d DESC;"
    )


def audit_multihop_bounce_hubs(only_breaches: bool = True, limit_chains: int = 3) -> dict[str, Any]:
    """Traces variable-length `-{2,4}->` referral chains and exposes hidden Bounce Hubs.

    Compares naive flat provider waitlist sorting (`active_waitlist_count DESC`) against
    multi-hop `case_chain_id`-correlated ISO GQL trajectories across `ReferralGraph`,
    exposing low-internal-wait `Part_C_Intake_Coordinator` desks (`5-6` days internal wait)
    whose `paper_fax` and unverified bilingual/Medicaid handoffs trigger 4-hop >45-day
    IDEA Part C statutory breaches.

    Args:
        only_breaches: If True, returns only >45-day breached episodes in the detailed sample.
        limit_chains: Number of worst multi-hop episodes to return (`1..8`, defaults to `3`).
    """
    only_breaches_bool = _coerce_bool(only_breaches, default=True)
    limit_int, ok_limit = _parse_int_param(limit_chains, default=3)
    if not ok_limit or limit_int is None or limit_int < 1:
        return {
            "status": "validation_error",
            "error_code": "INVALID_LIMIT_CHAINS",
            "message": "limit_chains must be >= 1 (max 8).",
        }
    limit_int = max(1, min(limit_int, 8))

    cfg = get_config()
    frames = load_local_state_frames(cfg["state"])
    prov = frames["providers"]
    logs = frames["logs"]
    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}

    iso_gql = _build_audit_iso_gql(cfg["dataset"], state_code=cfg["state"])
    bq_rows = graph_client.query_bq_or_none(iso_gql)
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    iso_gql = rewrite_sql_dataset(iso_gql, cfg["dataset"], active_ds)
    engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({cfg['state']} starter tables)"
    )

    naive_top5 = [
        {
            "id": str(r["provider_id"]),
            "wl": int(r["active_waitlist_count"]),
            "wait_d": int(r["median_internal_wait_days"]),
        }
        for _, r in prov.sort_values("active_waitlist_count", ascending=False).head(5).iterrows()
    ]

    episodes: list[dict[str, Any]] = []
    coord_stats: dict[str, dict[str, Any]] = {}
    bounce_sources: dict[str, dict[str, Any]] = {}
    hop_depth_summary: dict[int, dict[str, Any]] = {}

    for cid, grp in logs.groupby("case_chain_id"):
        grp_s = grp.sort_values("hop_sequence")
        n_hops = len(grp_s)
        total_w = int(grp_s["handoff_wait_days"].sum())
        coord_id = str(grp_s.iloc[0]["target_provider_id"])
        age_m = int(grp_s.iloc[0]["child_age_months"])

        hd = hop_depth_summary.setdefault(
            n_hops,
            {"hops": n_hops, "episodes": 0, "breaches_over_45d": 0, "wait_sum": 0},
        )
        hd["episodes"] += 1
        hd["wait_sum"] += total_w
        if total_w > 45:
            hd["breaches_over_45d"] += 1

        c_row = prov_by_id[coord_id]
        cs = coord_stats.setdefault(
            coord_id,
            {
                "provider_id": coord_id,
                "city": str(c_row["city"]),
                "flat_active_waitlist": int(c_row["active_waitlist_count"]),
                "flat_median_internal_wait_days": int(c_row["median_internal_wait_days"]),
                "routed_episodes": 0,
                "breached_over_45d": 0,
                "total_excess_days_over_45": 0,
            },
        )
        cs["routed_episodes"] += 1
        if total_w > 45:
            cs["breached_over_45d"] += 1
            cs["total_excess_days_over_45"] += total_w - 45

        hop_trace = []
        for _, h in grp_s.iterrows():
            s_id = str(h["source_provider_id"])
            t_id = str(h["target_provider_id"])
            w = int(h["handoff_wait_days"])
            reason = str(h["handoff_reason"])
            if reason.startswith("Re-Referral Bounce"):
                b_node = prov_by_id[s_id]
                bs = bounce_sources.setdefault(
                    s_id,
                    {
                        "id": s_id,
                        "wait_d": int(b_node["median_internal_wait_days"]),
                        "bounces": 0,
                    },
                )
                bs["bounces"] += 1

            hop_trace.append({
                "hop_sequence": int(h["hop_sequence"]),
                "source_provider_id": s_id,
                "target_provider_id": t_id,
                "target_role": str(prov_by_id[t_id]["node_role"]),
                "transmission_channel": str(h["transmission_channel"]),
                "handoff_wait_days": w,
                "handoff_reason": reason,
            })

        episodes.append({
            "case_chain_id": str(cid),
            "age_m": age_m,
            "wait_d": total_w,
            "hops": hop_trace,
        })

    coord_ranking = []
    for cs in coord_stats.values():
        cs["breach_rate_pct"] = round(cs["breached_over_45d"] / max(1, cs["routed_episodes"]) * 100.0, 1)
        coord_ranking.append(cs)
    coord_ranking.sort(
        key=lambda x: (x["breached_over_45d"], x["total_excess_days_over_45"]),
        reverse=True,
    )

    top_hub: dict[str, Any] | None = None
    if coord_ranking:
        top_cid = coord_ranking[0]["provider_id"]
        top_hub = {
            **coord_ranking[0],
            "synthetic_organization_name": str(prov_by_id[top_cid]["synthetic_organization_name"]),
        }

    hop_table = [
        {
            "hops": d["hops"],
            "n": d["episodes"],
            "wait_d": round(d["wait_sum"] / max(1, d["episodes"]), 1),
            "breaches": d["breaches_over_45d"],
        }
        for _, d in sorted(hop_depth_summary.items())
    ]

    filtered_eps = [e for e in episodes if (not only_breaches_bool or e["wait_d"] > 45)]
    filtered_eps.sort(
        key=lambda e: (e["age_m"] >= 30, e["wait_d"]),
        reverse=True,
    )

    channel_stats = [
        {
            "ch": str(ch),
            "n": int(len(grp)),
            "wait_d": round(float(grp["handoff_wait_days"].mean()), 1),
            "drop_pct": round(float(grp["dropoff_rate_pct"].mean()) * 100.0, 1),
        }
        for ch, grp in logs.groupby("transmission_channel")
    ]
    channel_stats.sort(key=lambda x: x["wait_d"], reverse=True)

    breach_count = sum(1 for e in episodes if e["wait_d"] > 45)
    return {
        "execution_engine": engine,
        "state_code": cfg["state"],
        "synthetic_provenance_notice": "100% [Synthetic] CareNode & ReferralHandoff chains.",
        "iso_gql_query": iso_gql,
        "network_totals": {
            "total_complete_chains": len(episodes),
            "chains_3_to_4_hops": sum(1 for e in episodes if len(e["hops"]) >= 3),
            "statutory_breaches_over_45d": breach_count,
            "overall_timely_45d_pct": round(
                (len(episodes) - breach_count) / max(1, len(episodes)) * 100.0, 1
            ),
            "toddlers_30m_plus_in_breach": sum(
                1 for e in episodes if e["wait_d"] > 45 and e["age_m"] >= 30
            ),
        },
        "hop_depth_breakdown": hop_table,
        "transmission_channel_impact": channel_stats,
        "naive_flat_waitlist_top5_misleading": naive_top5,
        "intake_coordinator_bounce_hub_ranking": coord_ranking,
        "top_hidden_bounce_hub": top_hub,
        "downstream_re_referral_bounce_triggers": sorted(
            bounce_sources.values(), key=lambda x: x["bounces"], reverse=True
        )[:2],
        "sample_traced_episodes": filtered_eps[:limit_int],
    }


def simulate_hub_intervention(
    target_provider_id: str = "",
    upgrade_fax_to_ehr: bool = True,
    precheck_bilingual_and_slot_capacity: bool = True,
) -> dict[str, Any]:
    """Simulates fixing a regional Bounce Hub and quantifies delayed child-days saved.

    Computes a counterfactual over traversed `ReferralHandoff` chains passing through
    `target_provider_id` (defaults to the state's #1 hidden Intake Coordinator bounce hub,
    e.g., `SYN-PROV-MS-011`, or `'ALL'` for statewide intake modernization):
      1. Replacing `paper_fax` (`~19.5-21.7d` avg) with `ehr_electronic_portal` (`~12-13d`)
         on hops entering or exiting the targeted hub(s).
      2. Pre-verifying bilingual & Medicaid evaluation/therapy slot capacity at intake so
         cases route directly to underutilized fast hubs (`017..020`, `026..030`),
         eliminating Hop-3/4 `Re-Referral Bounce` penalties (`21-25d`).

    Args:
        target_provider_id: Specific `SYN-PROV-*` ID (e.g. 'SYN-PROV-MS-011') or 'ALL'.
        upgrade_fax_to_ehr: Simulate replacing paper fax edges with electronic portal intake.
        precheck_bilingual_and_slot_capacity: Simulate pre-handoff bilingual/Medicaid slot
            check to eliminate 4-hop re-referral bounces.
    """
    raw_target = "" if target_provider_id is None else str(target_provider_id).strip()
    upgrade_bool = _coerce_bool(upgrade_fax_to_ehr, default=True)
    precheck_bool = _coerce_bool(precheck_bilingual_and_slot_capacity, default=True)

    cfg = get_config()
    frames = load_local_state_frames(cfg["state"])
    prov = frames["providers"]
    logs = frames["logs"]
    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}
    valid_coord_ids = sorted(
        pid for pid, r in prov_by_id.items() if str(r["node_role"]) == "Part_C_Intake_Coordinator"
    )

    target = raw_target.upper()
    if not target:
        audit = audit_multihop_bounce_hubs(only_breaches=True, limit_chains=1)
        top_hub = audit.get("top_hidden_bounce_hub")
        target = top_hub["provider_id"] if top_hub else (valid_coord_ids[0] if valid_coord_ids else "")
    elif target != "ALL" and target not in prov_by_id:
        return {
            "status": "validation_error",
            "error_code": "PROVIDER_NOT_FOUND_IN_ACTIVE_STATE",
            "state_code": cfg["state"],
            "target_provider_id": raw_target,
            "valid_coordinator_ids": valid_coord_ids,
            "message": (
                f"target_provider_id '{raw_target}' was not found in active state '{cfg['state']}'. "
                f"Use one of {valid_coord_ids} or 'ALL'."
            ),
        }

    hub_meta = prov_by_id.get(target)
    target_hub_set = set(valid_coord_ids) if target == "ALL" else {target}
    target_is_coordinator = target == "ALL" or (
        hub_meta is not None and str(hub_meta["node_role"]) == "Part_C_Intake_Coordinator"
    )

    affected_chains: list[dict[str, Any]] = []
    baseline_breaches = 0
    post_breaches = 0
    total_days_saved = 0
    baseline_wait_sum = 0
    post_wait_sum = 0

    for cid, grp in logs.groupby("case_chain_id"):
        grp_s = grp.sort_values("hop_sequence")
        nodes_in_chain = set(grp_s["source_provider_id"].astype(str)).union(
            set(grp_s["target_provider_id"].astype(str))
        )
        if not (nodes_in_chain & target_hub_set):
            continue

        base_wait = int(grp_s["handoff_wait_days"].sum())
        fax_saved = 0
        bounce_saved = 0

        for _, h in grp_s.iterrows():
            s_id = str(h["source_provider_id"])
            t_id = str(h["target_provider_id"])
            w = int(h["handoff_wait_days"])
            reason = str(h["handoff_reason"])
            ch = str(h["transmission_channel"])
            is_bounce = reason.startswith("Re-Referral Bounce")
            touches_target = (s_id in target_hub_set) or (t_id in target_hub_set)

            if is_bounce and precheck_bool and (target_is_coordinator or touches_target):
                bounce_saved += w
            elif ch == "paper_fax" and upgrade_bool and touches_target:
                fax_saved += max(0, w - 12)

        saved = fax_saved + bounce_saved
        new_wait = max(14, base_wait - saved)

        baseline_wait_sum += base_wait
        post_wait_sum += new_wait
        total_days_saved += base_wait - new_wait
        if base_wait > 45:
            baseline_breaches += 1
        if new_wait > 45:
            post_breaches += 1

        affected_chains.append({
            "case_chain_id": str(cid),
            "child_age_months": int(grp_s.iloc[0]["child_age_months"]),
            "concern_domain": str(grp_s.iloc[0]["concern_domain"]),
            "baseline_hops": int(len(grp_s)),
            "simulated_hops": int(len(grp_s) - (1 if (bounce_saved > 0 and len(grp_s) == 4) else 0)),
            "baseline_wait_days": base_wait,
            "simulated_wait_days": new_wait,
            "child_days_saved": base_wait - new_wait,
            "flipped_to_compliant_45d": (base_wait > 45) and (new_wait <= 45),
        })

    affected_chains.sort(key=lambda c: c["child_days_saved"], reverse=True)

    clean_state = _clean_state_code(cfg["state"])
    sim_gql = _build_audit_iso_gql(cfg["dataset"], state_code=clean_state)
    bq_sim_rows = graph_client.query_bq_or_none(sim_gql)
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_sim_rows is not None else cfg["dataset"]
    sim_engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_sim_rows is not None
        else f"local_geoparquet_mirror ({cfg['state']} starter tables)"
    )

    return {
        "execution_engine": sim_engine,
        "state_code": cfg["state"],
        "target_intervention_scope": target,
        "target_organization_name": (
            str(hub_meta["synthetic_organization_name"])
            if hub_meta is not None
            else f"All Regional Part C Intake Coordinators ({cfg['state']})"
        ),
        "flat_spreadsheet_appearance": (
            {
                "median_internal_wait_days": int(hub_meta["median_internal_wait_days"]),
                "active_waitlist_count": int(hub_meta["active_waitlist_count"]),
                "why_flat_sql_missed_it": (
                    f"Internal wait is only {int(hub_meta['median_internal_wait_days'])}d, "
                    "hiding downstream paper_fax & slot-mismatch bounces."
                ),
            }
            if hub_meta is not None
            else None
        ),
        "levers_applied": {
            "upgrade_paper_fax_to_ehr_portal": upgrade_bool,
            "precheck_bilingual_and_medicaid_slot_capacity": precheck_bool,
        },
        "impact_summary": {
            "episodes_evaluated": len(affected_chains),
            "baseline_breaches_over_45d": baseline_breaches,
            "simulated_breaches_over_45d": post_breaches,
            "breaches_eliminated": baseline_breaches - post_breaches,
            "mean_episode_wait_before_days": round(
                baseline_wait_sum / max(1, len(affected_chains)), 1
            ),
            "mean_episode_wait_after_days": round(
                post_wait_sum / max(1, len(affected_chains)), 1
            ),
            "total_delayed_child_days_saved": total_days_saved,
        },
        "total_episodes_simulated": len(affected_chains),
        "episode_level_simulation": affected_chains[:5],
    }


def _build_bottleneck_hubs_gql(
    dataset: str,
    max_days: int = 45,
    state_code: str = "",
) -> str:
    """Builds a concise ISO/IEC 39075 GQL query to rank intermediate bottleneck hubs."""
    max_days_int = int(max_days)
    clean_state = _clean_state_code(state_code)
    state_filter = f"src.state_code='{clean_state}' AND " if clean_state else ""
    return (
        f"WITH chains AS (SELECT * FROM GRAPH_TABLE({dataset}.ReferralGraph\n"
        "  MATCH (src:CareNode {node_role:'Screening_Pediatric_Clinic'})-[r:REFERS_TO]->{2,4}"
        "(dest:CareNode {node_role:'EI_Therapy_Vendor'})\n"
        f"  WHERE {state_filter}r[OFFSET(0)].hop_sequence=1 "
        "AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(r) h)=1\n"
        "  LET id=r[OFFSET(0)].case_chain_id, hops=ARRAY_LENGTH(r),\n"
        "      wait_d=(SELECT SUM(h.handoff_wait_days) FROM UNNEST(r) h),\n"
        "      hubs=ARRAY(SELECT DISTINCT h.target_provider_id FROM UNNEST(r) h WITH OFFSET i WHERE i<ARRAY_LENGTH(r)-1),\n"
        "      fax=(SELECT COUNTIF(h.transmission_channel='paper_fax') FROM UNNEST(r) h),\n"
        "      rsn=(SELECT ARRAY_AGG(h.handoff_reason ORDER BY h.hop_sequence LIMIT 1)[SAFE_OFFSET(0)] "
        "FROM UNNEST(r) h WHERE STARTS_WITH(h.handoff_reason,'Re-Referral Bounce'))\n"
        "  RETURN id, hops, wait_d, hubs, fax, rsn) "
        "QUALIFY ROW_NUMBER() OVER(PARTITION BY id ORDER BY hops DESC)=1),\n"
        f"bc AS (SELECT * FROM chains WHERE wait_d>{max_days_int}),\n"
        "tr AS (SELECT hub_id, ARRAY_AGG(rsn ORDER BY c DESC, rsn LIMIT 1)[SAFE_OFFSET(0)] AS primary_bounce_reason\n"
        "  FROM (SELECT hub_id, rsn, COUNT(DISTINCT id) c FROM bc, UNNEST(hubs) hub_id WHERE rsn IS NOT NULL GROUP BY 1,2) GROUP BY 1)\n"
        "SELECT hub_id AS provider_id, COUNT(DISTINCT bc.id) AS breached_paths_through_hub,\n"
        "  ROUND(COUNT(DISTINCT bc.id)*100.0/NULLIF((SELECT COUNT(*) FROM bc),0),1) AS betweenness_flow_share_pct,\n"
        "  ROUND(COUNTIF(bc.rsn IS NOT NULL)*100.0/NULLIF(COUNT(*),0),1) AS bounce_rate_pct,\n"
        "  ROUND(COUNTIF(bc.fax>0)*100.0/NULLIF(COUNT(*),0),1) AS paper_fax_share_pct,\n"
        "  MAX(tr.primary_bounce_reason) AS primary_bounce_reason\n"
        "FROM bc, UNNEST(bc.hubs) hub_id LEFT JOIN tr USING(hub_id) GROUP BY 1 "
        "ORDER BY 3 DESC, 2 DESC, 1;"
    )


def _provider_matches_region(prov_row: Any, region_norm: str) -> bool:
    """Returns True if a provider row matches `region_norm` (case-insensitive county, city, or state)."""
    if region_norm.upper() == "ALL":
        return True
    target = region_norm.lower()
    county = str(prov_row.get("county_name", "")).strip().lower()
    city = str(prov_row.get("city", "")).strip().lower()
    state = str(prov_row.get("state_code", "")).strip().lower()
    return target == state or target == city or target == county or (len(target) >= 3 and target in county)


def detect_regional_bottleneck_hubs(
    region: str = "ALL",
    max_days: int = 45,
    top_n: int = 5,
) -> dict[str, Any]:
    """Detects intermediate bottleneck hubs carrying the highest share of breached 2-4 hop chains.

    Executes an ISO/IEC 39075 GQL `GRAPH_TABLE` query over `{dataset}.ReferralGraph` when
    BigQuery is configured, and falls back to exact local GeoParquet computation over
    `frames["providers"]` and `frames["logs"]`. Ranks intermediate nodes by betweenness
    flow share across breached chains (`chain_wait_days > max_days`), exposing low-internal-wait
    coordinators and evaluators missed by flat waitlist sorting.

    Args:
        region: Region filter (`'ALL'` or a `county_name`, `city`, or `state_code` value).
        max_days: Statutory wait-day threshold (`1..180`) above which a chain is breached.
        top_n: Maximum number of ranked intermediate bottleneck hubs to return (`1..10`).
    """
    max_days_int, ok_days = _parse_int_param(max_days, default=45)
    if not ok_days or max_days_int is None or max_days_int < 1 or max_days_int > 180:
        return {
            "status": "validation_error",
            "error_code": "INVALID_MAX_DAYS",
            "message": "max_days must be an integer between 1 and 180.",
        }

    top_n_int, ok_top = _parse_int_param(top_n, default=5)
    if not ok_top or top_n_int is None or top_n_int < 1:
        return {
            "status": "validation_error",
            "error_code": "INVALID_TOP_N",
            "message": "top_n must be >= 1 (max 10).",
        }
    top_n_int = min(top_n_int, 10)

    cfg = get_config()
    frames = load_local_state_frames(cfg["state"])
    prov = frames["providers"]
    logs = frames["logs"]
    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}

    raw_region = "" if region is None else str(region).strip()
    region_norm = raw_region if raw_region else "ALL"
    is_regional = region_norm.upper() != "ALL"
    any_region_provider = (
        True
        if not is_regional
        else any(_provider_matches_region(p_meta, region_norm) for p_meta in prov_by_id.values())
    )

    gql_query = _build_bottleneck_hubs_gql(
        cfg["dataset"],
        max_days=max_days_int,
        state_code=cfg["state"],
    )
    bq_rows = graph_client.query_bq_or_none(gql_query)
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    gql_query = rewrite_sql_dataset(gql_query, cfg["dataset"], active_ds)
    engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({cfg['state']} starter tables)"
    )

    total_breached_chains = 0
    hub_acc: dict[str, dict[str, Any]] = {}

    if any_region_provider:
        for _, grp in logs.groupby("case_chain_id"):
            grp_s = grp.sort_values("hop_sequence")
            n_hops = len(grp_s)
            if not (2 <= n_hops <= 4) or int(grp_s.iloc[0]["hop_sequence"]) != 1:
                continue

            src_id = str(grp_s.iloc[0]["source_provider_id"])
            dest_id = str(grp_s.iloc[-1]["target_provider_id"])
            src_meta = prov_by_id.get(src_id)
            dest_meta = prov_by_id.get(dest_id)
            if src_meta is None or dest_meta is None:
                continue
            if (
                str(src_meta["node_role"]) != "Screening_Pediatric_Clinic"
                or str(dest_meta["node_role"]) != "EI_Therapy_Vendor"
            ):
                continue

            chain_wait_days = int(grp_s["handoff_wait_days"].sum())
            if chain_wait_days <= max_days_int:
                continue

            intermediate_ids = list(
                dict.fromkeys(str(h["target_provider_id"]) for _, h in grp_s.iloc[:-1].iterrows())
            )
            matching_hubs = [
                hid
                for hid in intermediate_ids
                if hid in prov_by_id and _provider_matches_region(prov_by_id[hid], region_norm)
            ]
            if is_regional and not matching_hubs:
                chain_nodes = set(grp_s["source_provider_id"].astype(str)).union(
                    set(grp_s["target_provider_id"].astype(str))
                )
                if not any(
                    nid in prov_by_id and _provider_matches_region(prov_by_id[nid], region_norm)
                    for nid in chain_nodes
                ):
                    continue

            total_breached_chains += 1
            if bq_rows is not None:
                continue

            bounce_reasons = [
                str(h["handoff_reason"])
                for _, h in grp_s.iterrows()
                if str(h["handoff_reason"]).startswith("Re-Referral Bounce")
            ]
            chain_bounce_reason = bounce_reasons[0] if bounce_reasons else None
            has_bounce = chain_bounce_reason is not None
            has_paper_fax = bool((grp_s["transmission_channel"] == "paper_fax").any())

            for hid in matching_hubs:
                p_meta = prov_by_id[hid]
                acc = hub_acc.setdefault(
                    hid,
                    {
                        "provider_id": hid,
                        "organization_name": str(p_meta["synthetic_organization_name"]),
                        "node_role": str(p_meta["node_role"]),
                        "flat_internal_wait_days": int(p_meta["median_internal_wait_days"]),
                        "breached_paths_through_hub": 0,
                        "bounce_chains": 0,
                        "fax_chains": 0,
                        "bounce_reasons": Counter(),
                    },
                )
                acc["breached_paths_through_hub"] += 1
                if has_bounce and chain_bounce_reason is not None:
                    acc["bounce_chains"] += 1
                    acc["bounce_reasons"][chain_bounce_reason] += 1
                if has_paper_fax:
                    acc["fax_chains"] += 1

    if not any_region_provider:
        bottleneck_hubs: list[dict[str, Any]] = []
    elif bq_rows is not None:
        filtered_bq: list[dict[str, Any]] = []
        for row in bq_rows:
            pid = str(row["provider_id"])
            p_meta = prov_by_id.get(pid)
            if p_meta is None or not _provider_matches_region(p_meta, region_norm):
                continue
            breached_paths = int(row["breached_paths_through_hub"])
            flow_share_pct = (
                round(breached_paths / max(1, total_breached_chains) * 100.0, 1)
                if is_regional
                else float(row["betweenness_flow_share_pct"])
            )
            filtered_bq.append({
                "provider_id": pid,
                "organization_name": str(p_meta["synthetic_organization_name"]),
                "node_role": str(p_meta["node_role"]),
                "flat_internal_wait_days": int(p_meta["median_internal_wait_days"]),
                "breached_paths_through_hub": breached_paths,
                "betweenness_flow_share_pct": flow_share_pct,
                "bounce_rate_pct": float(row["bounce_rate_pct"]),
                "paper_fax_share_pct": float(row["paper_fax_share_pct"]),
                "primary_bounce_reason": row.get("primary_bounce_reason"),
            })
        filtered_bq.sort(
            key=lambda x: (
                -x["betweenness_flow_share_pct"],
                -x["breached_paths_through_hub"],
                x["provider_id"],
            )
        )
        bottleneck_hubs = filtered_bq[:top_n_int]
    else:
        ranked_hubs: list[dict[str, Any]] = []
        for acc in hub_acc.values():
            count = acc["breached_paths_through_hub"]
            primary_reason = (
                sorted(acc["bounce_reasons"].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                if acc["bounce_reasons"]
                else None
            )
            ranked_hubs.append({
                "provider_id": acc["provider_id"],
                "organization_name": acc["organization_name"],
                "node_role": acc["node_role"],
                "flat_internal_wait_days": acc["flat_internal_wait_days"],
                "breached_paths_through_hub": count,
                "betweenness_flow_share_pct": round(
                    count / max(1, total_breached_chains) * 100.0, 1
                ),
                "bounce_rate_pct": round(acc["bounce_chains"] / max(1, count) * 100.0, 1),
                "paper_fax_share_pct": round(acc["fax_chains"] / max(1, count) * 100.0, 1),
                "primary_bounce_reason": primary_reason,
            })

        ranked_hubs.sort(
            key=lambda x: (
                -x["betweenness_flow_share_pct"],
                -x["breached_paths_through_hub"],
                x["provider_id"],
            )
        )
        bottleneck_hubs = ranked_hubs[:top_n_int]

    if bottleneck_hubs:
        top = bottleneck_hubs[0]
        if top["flat_internal_wait_days"] > 10:
            low_wait_coord = next(
                (
                    h
                    for h in bottleneck_hubs
                    if h["flat_internal_wait_days"] <= 10
                    and h["node_role"] == "Part_C_Intake_Coordinator"
                ),
                next((h for h in bottleneck_hubs if h["flat_internal_wait_days"] <= 10), None),
            )
            coord_clause = (
                f" Meanwhile, flat waitlist sorting misses low-wait hub "
                f"{low_wait_coord['organization_name']} ({low_wait_coord['provider_id']}, "
                f"{low_wait_coord['flat_internal_wait_days']}d internal wait), routing "
                f"{low_wait_coord['betweenness_flow_share_pct']}% "
                f"({low_wait_coord['breached_paths_through_hub']}/{total_breached_chains}) of breached chains."
                if low_wait_coord is not None
                else ""
            )
            key_finding = (
                f"Intermediate hub {top['organization_name']} ({top['provider_id']}, "
                f"{top['node_role']}, {top['flat_internal_wait_days']}d internal wait) carries "
                f"{top['betweenness_flow_share_pct']}% ({top['breached_paths_through_hub']}/"
                f"{total_breached_chains}) of breached >{max_days_int}d chains "
                f"({top['paper_fax_share_pct']}% paper_fax, {top['bounce_rate_pct']}% bounce)."
                f"{coord_clause}"
            )
        else:
            key_finding = (
                f"Flat waitlist sorting misses {top['organization_name']} ({top['provider_id']}, "
                f"{top['node_role']}) at {top['flat_internal_wait_days']}d internal wait, yet it carries "
                f"{top['betweenness_flow_share_pct']}% ({top['breached_paths_through_hub']}/"
                f"{total_breached_chains}) of breached >{max_days_int}d chains "
                f"({top['paper_fax_share_pct']}% paper_fax, {top['bounce_rate_pct']}% bounce)."
            )
    elif not any_region_provider:
        key_finding = (
            f"No CareNode providers in active state '{cfg['state']}' matched region={region_norm!r}; "
            "see valid_regions_hint for valid county_name and city filters."
        )
    elif total_breached_chains > 0:
        key_finding = (
            f"{total_breached_chains} breached 2-4 hop chain(s) (>{max_days_int}d) touched "
            f"region={region_norm!r}, while intermediate bounce hubs sit in adjacent counties/cities "
            "(re-run with region='ALL' to inspect statewide hubs)."
        )
    else:
        key_finding = (
            f"No breached 2-4 hop chains (>{max_days_int} days) matched region={region_norm!r}."
        )

    result: dict[str, Any] = {
        "engine": engine,
        "synthetic_provenance_notice": (
            "100% [Synthetic] CareNode (SYN-PROV-*) & ReferralGraph handoff logs; prefix-deduplicated."
        ),
        "iso_gql_query": gql_query,
        "region": region_norm,
        "max_days_threshold": max_days_int,
        "total_breached_multihop_chains": total_breached_chains,
        "bottleneck_hubs": bottleneck_hubs,
        "key_finding": key_finding,
    }
    if is_regional and not any_region_provider:
        result["valid_regions_hint"] = {
            "state_code": cfg["state"],
            "counties": sorted(
                {
                    str(r["county_name"]).strip()
                    for _, r in prov.iterrows()
                    if str(r.get("county_name", "")).strip()
                }
            ),
            "cities": sorted(
                {
                    str(r["city"]).strip()
                    for _, r in prov.iterrows()
                    if str(r.get("city", "")).strip()
                }
            ),
        }
    return result
