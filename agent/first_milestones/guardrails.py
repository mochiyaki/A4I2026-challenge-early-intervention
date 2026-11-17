"""Programmatic ADK 2.14.1 Guardrail Callbacks for First Milestones.

Enforces deterministic runtime safety, anti-bias data governance, synthetic
provenance honesty, and IDEA Part C 36-month transition callouts regardless of
LLM prompt compliance:
  - `guardrail_before_tool_callback`: Blocks destructive SQL and any SQL query
    that sorts or filters on post-output `audit_*` demographic columns or the
    all-zero `limited_english_rate` column.
  - `guardrail_after_model_callback`: Logs warnings for malformed `SYN-PROV-*`
    IDs, enforces `100% [Synthetic]` provenance disclosure on substantive
    clinical/audit replies, and enforces the 36-month / Part B transition
    safeguard whenever a child aged 30-35 months is discussed.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

logger = logging.getLogger("first_milestones.guardrails")

PROVENANCE_NOTICE = (
    "\n\n> **Provenance & Data Rigor Notice:** All providers (`SYN-PROV-*`), "
    "agencies (`SYN-PARTC-*`), and referral logs are `100% [Synthetic]`; "
    "Census ACS under-5 counts are real tract data and HRSA NSCH screening "
    "strata remain `Statewide` (6 rows)."
)

_DESTRUCTIVE_SQL_RE = re.compile(
    r"\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER|CREATE)\b",
    re.IGNORECASE,
)
_AUDIT_COL_RE = re.compile(r"\baudit_[a-z0-9_]+\b", re.IGNORECASE)
_LEP_COL_RE = re.compile(r"\blimited_english_rate\b", re.IGNORECASE)
_LEP_WEIGHTING_RE = re.compile(
    r"(?:[\*\+\-\/]\s*(?:[a-z_][a-z0-9_]*\.)?limited_english_rate\b"
    r"|\blimited_english_rate\s*[\*\+\-\/])",
    re.IGNORECASE,
)
_CLAUSE_START_RE = re.compile(r"\b(WHERE|HAVING|ORDER\s+BY)\b", re.IGNORECASE)
_CLAUSE_END_RE = re.compile(
    r"^(?:GROUP\s+BY|ORDER\s+BY|HAVING|QUALIFY|LIMIT|OFFSET|FETCH|WINDOW|UNION|EXCEPT|INTERSECT|FOR)\b",
    re.IGNORECASE,
)

_SUBSTANTIVE_REF_RE = re.compile(
    r"SYN-PROV-|SYN-PARTC-|CHAIN-|\b45[\s-]*(?:calendar\s+)?days?\b|\b<=?\s*45\s*d\b"
    r"|limited_english_rate|\baudit_[a-z_]+\b|\bnsch\b|active_waitlist_count"
    r"|early\s+intervention|\bpart\s+c\b",
    re.IGNORECASE,
)
_AGE_30_TO_35_RE = re.compile(
    r"\b(3[0-5](?:\.\d+)?)(?:\s*-\s*|\s+)months?(?:-old)?\b",
    re.IGNORECASE,
)
_TRANSITION_MENTION_RE = re.compile(
    r"\b36\s*[-\s]?months?\b|\bpart\s*b\b",
    re.IGNORECASE,
)
_PROVIDER_TOKEN_RE = re.compile(r"\bSYN-PROV-(?!\*)([A-Za-z0-9_-]+)")
_VALID_PROVIDER_ID_RE = re.compile(r"^SYN-PROV-(?:MS|AL|GA|TX|CA|NY)-\d{3}$")

_KNOWN_PROVIDER_IDS: set[str] | None = None


def _get_known_provider_ids() -> set[str]:
    """Lazily caches valid synthetic provider IDs across all 6 starter states."""
    global _KNOWN_PROVIDER_IDS
    if _KNOWN_PROVIDER_IDS is not None:
        return _KNOWN_PROVIDER_IDS
    known: set[str] = set()
    try:
        from .tools.bq_client import VALID_STATES, load_local_state_frames

        for st in VALID_STATES:
            frames = load_local_state_frames(st)
            provs = frames.get("providers")
            if provs is not None and "provider_id" in provs.columns:
                known.update(str(pid).strip() for pid in provs["provider_id"].dropna())
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping known-provider directory cache: %s", exc)
    _KNOWN_PROVIDER_IDS = known
    return known


def _strip_sql_comments(sql: str) -> str:
    """Removes `--` line comments and `/* ... */` block comments before inspection."""
    no_block = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", no_block)


def _extract_clauses(sql: str) -> dict[str, list[str]]:
    """Extracts WHERE, HAVING, and ORDER BY clause bodies respecting parentheses."""
    clauses: dict[str, list[str]] = {"WHERE": [], "HAVING": [], "ORDER BY": []}
    for match in _CLAUSE_START_RE.finditer(sql):
        kw = re.sub(r"\s+", " ", match.group(1).upper())
        pos = match.end()
        depth = 0
        end = len(sql)
        i = pos
        in_single_quote = False
        while i < len(sql):
            ch = sql[i]
            if ch == "'" and (i == 0 or sql[i - 1] != "\\"):
                in_single_quote = not in_single_quote
                i += 1
                continue
            if in_single_quote:
                i += 1
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                if depth == 0:
                    end = i
                    break
                depth -= 1
            elif ch == ";" and depth == 0:
                end = i
                break
            elif depth == 0 and (i == pos or not sql[i - 1].isalnum()):
                if _CLAUSE_END_RE.match(sql[i:]):
                    end = i
                    break
            i += 1
        clauses[kw].append(sql[pos:end])
    return clauses


def _collect_sql_strings(tool_name: str, args: dict[str, Any] | None) -> list[str]:
    """Collects SQL strings from tool arguments for inspection."""
    if not isinstance(args, dict):
        return []
    is_sql_tool = "sql" in tool_name.lower()
    sql_keys = {"query", "sql", "statement", "sql_query"}
    collected: list[str] = []

    def _walk(obj: Any, key_hint: str = "") -> None:
        if isinstance(obj, str):
            if is_sql_tool or key_hint.lower() in sql_keys:
                collected.append(obj)
        elif isinstance(obj, dict):
            for k, v in obj.items():
                _walk(v, str(k))
        elif isinstance(obj, list):
            for item in obj:
                _walk(item, key_hint)

    _walk(args)
    return collected


def _inspect_non_sql_tool_args(tool_name: str, args: dict[str, Any] | None) -> dict[str, Any] | None:
    """Blocks `audit_*` demographic keys/values and `limited_english_rate` in routing/gatekeeper/slot tools."""
    if not isinstance(args, dict):
        return None
    lower_name = tool_name.lower()
    if "sql" in lower_name or lower_name == "run_post_output_equity_audit":
        return None

    def _walk(obj: Any) -> dict[str, Any] | None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                key_str = str(k)
                audit_key = _AUDIT_COL_RE.search(key_str)
                if audit_key:
                    col = audit_key.group(0)
                    logger.warning(
                        "Blocked post-output demographic arg key %s in tool %s",
                        col,
                        tool_name,
                    )
                    return {
                        "error": "GUARDRAIL_BLOCKED_AUDIT_SORT_OR_FILTER",
                        "blocked": True,
                        "tool": tool_name,
                        "column": col,
                        "reason": (
                            f"Passing post-output demographic key '{col}' to '{tool_name}' "
                            "violates the IDEA Part C anti-bias routing firewall."
                        ),
                    }
                if _LEP_COL_RE.search(key_str):
                    logger.warning(
                        "Blocked all-zero limited_english_rate arg key in tool %s",
                        tool_name,
                    )
                    return {
                        "error": "GUARDRAIL_BLOCKED_LEP_ZERO_TRAP",
                        "blocked": True,
                        "tool": tool_name,
                        "column": "limited_english_rate",
                        "reason": (
                            "Using `limited_english_rate` is blocked because it is 0.0 across "
                            "all tracts in this ACS extract."
                        ),
                    }
                hit = _walk(v)
                if hit is not None:
                    return hit
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                hit = _walk(item)
                if hit is not None:
                    return hit
        elif isinstance(obj, str):
            audit_val = _AUDIT_COL_RE.search(obj)
            if audit_val:
                col = audit_val.group(0)
                logger.warning(
                    "Blocked post-output demographic arg value %s in tool %s",
                    col,
                    tool_name,
                )
                return {
                    "error": "GUARDRAIL_BLOCKED_AUDIT_SORT_OR_FILTER",
                    "blocked": True,
                    "tool": tool_name,
                    "column": col,
                    "reason": (
                        f"Referencing post-output demographic column '{col}' in '{tool_name}' "
                        "violates the IDEA Part C anti-bias routing firewall."
                    ),
                }
            if _LEP_COL_RE.search(obj):
                logger.warning(
                    "Blocked all-zero limited_english_rate arg value in tool %s",
                    tool_name,
                )
                return {
                    "error": "GUARDRAIL_BLOCKED_LEP_ZERO_TRAP",
                    "blocked": True,
                    "tool": tool_name,
                    "column": "limited_english_rate",
                    "reason": (
                        "Using `limited_english_rate` is blocked because it is 0.0 across "
                        "all tracts in this ACS extract."
                    ),
                }
        return None

    return _walk(args)


def guardrail_before_tool_callback(
    tool: BaseTool,
    args: dict[str, Any],
    tool_context: ToolContext,
) -> dict[str, Any] | None:
    """Blocks destructive SQL and anti-bias / LEP-trap SQL or tool-arg violations before execution."""
    del tool_context  # Signature required by ADK 2.14.1 BeforeToolCallback
    tool_name = str(getattr(tool, "name", "") or "")
    arg_violation = _inspect_non_sql_tool_args(tool_name, args)
    if arg_violation is not None:
        return arg_violation

    sql_strings = _collect_sql_strings(tool_name, args)
    if not sql_strings:
        return None

    for raw_sql in sql_strings:
        cleaned_sql = _strip_sql_comments(raw_sql)

        destructive = _DESTRUCTIVE_SQL_RE.search(cleaned_sql)
        if destructive:
            kw = destructive.group(1).upper()
            logger.warning(
                "Blocked destructive SQL keyword %s in tool %s",
                kw,
                tool_name,
            )
            return {
                "error": "GUARDRAIL_BLOCKED_DESTRUCTIVE_SQL",
                "blocked": True,
                "tool": tool_name,
                "keyword": kw,
                "reason": (
                    f"Destructive or mutating SQL keyword '{kw}' is prohibited. "
                    "Only read-only SELECT / GRAPH_TABLE queries are permitted."
                ),
            }

        clauses = _extract_clauses(cleaned_sql)
        for clause_name in ("ORDER BY", "WHERE", "HAVING"):
            for body in clauses[clause_name]:
                audit_hit = _AUDIT_COL_RE.search(body)
                if audit_hit:
                    col = audit_hit.group(0)
                    logger.warning(
                        "Blocked %s on post-output demographic column %s in tool %s",
                        clause_name,
                        col,
                        tool_name,
                    )
                    return {
                        "error": "GUARDRAIL_BLOCKED_AUDIT_SORT_OR_FILTER",
                        "blocked": True,
                        "tool": tool_name,
                        "column": col,
                        "clause": clause_name,
                        "reason": (
                            f"Using '{col}' in SQL {clause_name} violates the IDEA Part C "
                            "anti-bias routing firewall. `audit_*` columns are strictly "
                            "post-output equity audit metrics."
                        ),
                    }
                if _LEP_COL_RE.search(body):
                    logger.warning(
                        "Blocked %s on all-zero limited_english_rate in tool %s",
                        clause_name,
                        tool_name,
                    )
                    return {
                        "error": "GUARDRAIL_BLOCKED_LEP_ZERO_TRAP",
                        "blocked": True,
                        "tool": tool_name,
                        "column": "limited_english_rate",
                        "clause": clause_name,
                        "reason": (
                            "Filtering or sorting by `limited_english_rate` is blocked because "
                            "it is 0.0 across all tracts in this ACS extract. Use "
                            "`bilingual_services_listed` and statewide NSCH strata instead."
                        ),
                    }

        if _LEP_WEIGHTING_RE.search(cleaned_sql):
            logger.warning(
                "Blocked arithmetic weighting on all-zero limited_english_rate in tool %s",
                tool_name,
            )
            return {
                "error": "GUARDRAIL_BLOCKED_LEP_ZERO_TRAP",
                "blocked": True,
                "tool": tool_name,
                "column": "limited_english_rate",
                "reason": (
                    "Weighting tract priority by `limited_english_rate` is blocked because "
                    "it is 0.0 across all tracts in this ACS extract."
                ),
            }

    return None


def guardrail_after_model_callback(
    callback_context: CallbackContext,
    llm_response: LlmResponse,
) -> LlmResponse | None:
    """Enforces synthetic provenance disclosure, 36-month safeguards, and ID checks."""
    del callback_context  # Signature required by ADK 2.14.1 AfterModelCallback
    if llm_response is None or llm_response.content is None:
        return None
    parts = getattr(llm_response.content, "parts", None) or []
    text_indices = [
        idx for idx, p in enumerate(parts) if isinstance(getattr(p, "text", None), str) and p.text.strip()
    ]
    if not text_indices:
        return None

    full_text = "\n".join(parts[idx].text for idx in text_indices)

    known_providers = _get_known_provider_ids()
    unknown_ids: list[str] = []
    for m in _PROVIDER_TOKEN_RE.finditer(full_text):
        candidate_id = f"SYN-PROV-{m.group(1)}"
        if not _VALID_PROVIDER_ID_RE.match(candidate_id):
            logger.warning(
                "Malformed synthetic provider ID cited in model output: %s",
                candidate_id,
            )
            unknown_ids.append(candidate_id)
        elif known_providers and candidate_id not in known_providers:
            logger.warning(
                "Hallucinated / non-existent synthetic provider ID cited in model output: %s",
                candidate_id,
            )
            unknown_ids.append(candidate_id)

    sanitized_text = False
    new_parts = list(parts)
    if unknown_ids and known_providers:
        # Strip ungrounded/hallucinated SYN-PROV-* IDs that do not exist in starter state tables
        unknown_set = set(unknown_ids)
        for idx in text_indices:
            orig = new_parts[idx].text
            replaced = orig
            for uid in unknown_set:
                if uid in replaced:
                    replaced = replaced.replace(uid, "[verified directory lookup required]")
            if replaced != orig:
                new_parts[idx] = types.Part.from_text(text=replaced)
                sanitized_text = True
        full_text = "\n".join(new_parts[idx].text for idx in text_indices)

    additions: list[str] = []
    normalized_text = re.sub(r"[*`]", "", full_text).lower()
    if _SUBSTANTIVE_REF_RE.search(full_text) and "100% [synthetic]" not in normalized_text:
        additions.append(PROVENANCE_NOTICE)

    age_match = _AGE_30_TO_35_RE.search(full_text)
    if age_match and not _TRANSITION_MENTION_RE.search(full_text):
        additions.append(
            f"\n\n> **36-Month IDEA Part C Cutoff Safeguard:** At **{age_match.group(1)} months**, "
            "initiate concurrent **IDEA Part B** preschool transition notice immediately so "
            "evaluation and IFSP delivery finish before the strict **36-month** Part C aging-out cutoff."
        )

    if not additions and not sanitized_text:
        return None

    suffix = "".join(additions)
    if suffix:
        last_idx = text_indices[-1]
        last_part = new_parts[last_idx]
        new_parts[last_idx] = types.Part.from_text(text=f"{last_part.text.rstrip()}{suffix}")

    updated_content = types.Content(
        role=getattr(llm_response.content, "role", "model") or "model",
        parts=new_parts,
    )
    if hasattr(llm_response, "model_copy"):
        return llm_response.model_copy(update={"content": updated_content})
    return LlmResponse(content=updated_content)
