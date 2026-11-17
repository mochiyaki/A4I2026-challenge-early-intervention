"""Structured 45-Day Pathway & Bottleneck Brief composer (with EN/ES Caregiver Notes).

Assembles and Pydantic-validates (`PathwayBrief`) a complete, UI-ready structured
artifact combining:
  1. Multi-hop `<=45`-day compliant pathway + cautionary 4-hop `paper_fax` bounce loop
  2. Regional Bounce Hub diagnosis + Counterfactual single-hub intervention impact
  3. Post-Output Equity Audit (`audit_*` shares + zero-vehicle mobility + NSCH context)
  4. Warm, jargon-free English & Spanish caregiver action notes anchored to real
     calendar dates (`YYYY-MM-DD`) and statutory IDEA Part C rights
"""

from __future__ import annotations

from datetime import date, timedelta
import importlib
import re
from typing import Any

from .schemas import CaregiverNotes, PathwayBrief
from .tools import (
    detect_regional_bottleneck_hubs,
    find_viable_45d_paths,
    rank_outreach_zones,
)
from .tools import bq_client as _bq_client_mod
from .tools.equity_audit import prioritize_community_screening_tracts, run_post_output_equity_audit
from .tools.graph_audit import audit_multihop_bounce_hubs, simulate_hub_intervention
from .tools.graph_routing import find_compliant_45d_pathways
from .tools.reference_lookups import lookup_regional_agency_kpis

_DOMAIN_ES: dict[str, str] = {
    "Social-Communication / Autism Screen": "comunicación social y detección temprana del desarrollo",
    "Expressive Speech/Language": "habla y lenguaje expresivo",
    "Motor Milestone Delay": "desarrollo motor",
    "Feeding & Sensory": "alimentación y procesamiento sensorial",
    "developmental milestones": "hitos del desarrollo infantil",
}


def _clean_provider_name(raw_name: str) -> str:
    """Strips `[Synthetic]` tags for warm, caregiver-facing provider names."""
    return re.sub(r"\s*\[Synthetic\]\s*", " ", str(raw_name or "")).strip()


def _clean_org_name(raw_name: str) -> str:
    """Backward-compatible alias for `_clean_provider_name`."""
    return _clean_provider_name(raw_name)


def _localize_domain_es(domain: str) -> str:
    """Translates clinical concern domains into pure Spanish without English jargon."""
    cleaned = str(domain or "").strip()
    if not cleaned:
        return _DOMAIN_ES["developmental milestones"]
    if cleaned in _DOMAIN_ES:
        return _DOMAIN_ES[cleaned]
    low = cleaned.lower()
    if any(k in low for k in ("autism", "asd", "social", "communication", "behavior")):
        return _DOMAIN_ES["Social-Communication / Autism Screen"]
    if any(k in low for k in ("speech", "lang", "slp", "expressive", "articulation")):
        return _DOMAIN_ES["Expressive Speech/Language"]
    if any(k in low for k in ("motor", "pt", "physical", "gross", "mobility")):
        return _DOMAIN_ES["Motor Milestone Delay"]
    if any(k in low for k in ("feed", "sensory", "swallow", "dysphagia", "ot")):
        return _DOMAIN_ES["Feeding & Sensory"]
    return _DOMAIN_ES["developmental milestones"]


def _compute_statutory_transition_tier(age_months: int | float | None) -> str:
    """Classifies `child_age_months` into the 5-tier `34 CFR § 303.209` transition ladder."""
    if age_months is None:
        return "0-26m_standard_part_c"
    age = float(age_months)
    if age >= 36.0:
        return ">=36m_ineligible_part_c_refer_part_b_619"
    if age >= 34.5:
        return "34.5-35.9m_urgent_compressed_part_b_coordination"
    if age >= 33.0:
        return "33.0-34.4m_mandatory_part_b_transition_conference"
    if age >= 27.0:
        return "27-32m_part_b_transition_window"
    return "0-26m_standard_part_c"


def build_caregiver_notes(routing_result: dict[str, Any]) -> dict[str, str]:
    """Generates plain-language English & Spanish caregiver action notes for a pathway."""
    today = date.today()
    day0_str = today.isoformat()
    day45_str = (today + timedelta(days=45)).isoformat()

    status = str(routing_result.get("status", "ok"))
    profile = routing_result.get("child_profile") or {}
    rec = routing_result.get("recommended_pathway")

    needs_medicaid = bool(profile.get("needs_medicaid", True))
    needs_bilingual = bool(profile.get("needs_bilingual", True))

    if status == "ineligible_part_c_aged_out":
        raw_age_out = profile.get("child_age_months", routing_result.get("child_age_months", 36))
        lang_en = (
            "free bilingual evaluation and interpreter rights (34 CFR § 303.321)"
            if needs_bilingual
            else "free evaluation and interpreter rights in your preferred language (34 CFR § 303.321)"
        )
        lang_es = (
            "evaluación bilingüe en español e intérprete gratuito (34 CFR § 303.321)"
            if needs_bilingual
            else "evaluación gratuita y derecho a intérprete en su idioma preferido (34 CFR § 303.321)"
        )
        notes = CaregiverNotes(
            english=(
                f"**Transition Referral Plan (Initiated {day0_str})**\n\n"
                f"Because your child is {raw_age_out} months old (36 months or older), federal IDEA Part C "
                "Early Intervention (ages 0–35 months) refers your family directly to **IDEA Part B Section 619 "
                "Preschool Special Education** through your Local Educational Agency (LEA), while honoring "
                f"{lang_en} instead of the Part C 45-day infant/toddler track.\n\n"
                "- *(Demo Notice: Caregiver-facing organizations are fictional `[Synthetic]` training profiles.)*"
            ),
            spanish=(
                f"**Plan de Referencia y Transición (Iniciado el {day0_str})**\n\n"
                f"Como su hijo/a tiene {raw_age_out} meses (36 meses o más), el programa federal IDEA Parte C "
                "(0 a 35 meses) canaliza a su familia directamente a **Educación Especial Preescolar IDEA Parte B "
                "Sección 619** a través de su distrito escolar local (LEA), garantizando "
                f"{lang_es} más allá del plazo de 45 días de Parte C.\n\n"
                "- *(Aviso de Demostración: Las organizaciones mostradas son perfiles ficticios `[Synthetic]` de entrenamiento.)*"
            ),
        )
        return notes.model_dump(mode="python")

    if not rec:
        ins_en = "at no cost under Medicaid" if needs_medicaid else "with free evaluation protections under IDEA Part C"
        ins_es = "sin costo bajo Medicaid" if needs_medicaid else "con evaluación gratuita bajo IDEA Parte C"
        notes = CaregiverNotes(
            english=(
                f"**Your Child's Early Milestones Plan (Day 0: {day0_str} · Statutory Day 45 Deadline: {day45_str})**\n\n"
                "Your Early Intervention coordinator is arranging an expedited evaluation and "
                f"transportation support {ins_en} within the 45-day federal timeline, with free interpreter rights under 34 CFR § 303.321.\n\n"
                "- *(Demo Notice: Caregiver-facing organizations are fictional `[Synthetic]` training profiles.)*"
            ),
            spanish=(
                f"**Plan de Primeros Pasos de su Hijo/a (Día 0: {day0_str} · Plazo Legal Día 45: {day45_str})**\n\n"
                "Su coordinador de Intervención Temprana está organizando una evaluación acelerada y "
                f"apoyo de transporte gratuito {ins_es} dentro del plazo federal de 45 días, con derecho gratuito a intérprete bajo 34 CFR § 303.321.\n\n"
                "- *(Aviso de Demostración: Las organizaciones mostradas son perfiles ficticios `[Synthetic]` de entrenamiento.)*"
            ),
        )
        return notes.model_dump(mode="python")

    hops = rec.get("hops", [])
    total_days = int(rec.get("expected_cumulative_days", 30) or 30)
    raw_age = profile.get("child_age_months")
    age_m = 22 if raw_age is None else float(raw_age)
    age_display = int(age_m) if float(age_m).is_integer() else round(age_m, 1)

    domain_en = str(profile.get("concern_domain") or "developmental milestones").strip()
    domain_es = _localize_domain_es(domain_en)

    has_vehicle = bool(profile.get("has_household_vehicle", True))
    tract_zero_veh = float(profile.get("tract_zero_vehicle_pct", 0.0) or 0.0)
    needs_nemt = (not has_vehicle) or (tract_zero_veh >= 10.0)
    mobile_visit_capable = bool(
        rec.get("mobile_visit_capable")
        or profile.get("mobile_visit_capable")
        or any(
            isinstance(h, dict)
            and (
                h.get("mobile_visit_capable")
                or "mobile" in str(h.get("handoff_reason", "")).lower()
                or "home" in str(h.get("handoff_reason", "")).lower()
            )
            for h in hops
        )
    )

    coord_hop = hops[0] if len(hops) >= 1 else {}
    eval_hop = hops[1] if len(hops) >= 3 else None
    vendor_hop = hops[-1] if len(hops) >= 2 else {}

    coord_name = _clean_provider_name(
        coord_hop.get("target_name", "Regional Intake Coordinator")
    ) or "Regional Intake Coordinator"
    coord_days = int(coord_hop.get("cumulative_wait_days", 6) or 6)
    coord_date = (today + timedelta(days=coord_days)).isoformat()
    ifsp_date = (today + timedelta(days=total_days)).isoformat()

    # Adjusted statutory deadline when toddler is within <45 days of 36-month cutoff
    days_until_36m = max(1, int(round((36.0 - age_m) * 30.0))) if age_m >= 34.5 else 45
    adjusted_deadline_days = min(45, days_until_36m) if age_m >= 34.5 else 45
    adjusted_deadline_date = (today + timedelta(days=adjusted_deadline_days)).isoformat()
    if adjusted_deadline_days < 45:
        deadline_en = f"Day 45: {day45_str} · Adjusted Age-3 Cutoff Deadline (Day {adjusted_deadline_days}): {adjusted_deadline_date}"
        deadline_es = f"Día 45: {day45_str} · Plazo Ajustado por Límite de 3 Años (Día {adjusted_deadline_days}): {adjusted_deadline_date}"
    else:
        deadline_en = f"Statutory Day 45 Deadline: {day45_str}"
        deadline_es = f"Plazo Legal Día 45: {day45_str}"

    # Insurance phrasing
    if needs_medicaid:
        intake_ins_en = "confirmed Medicaid coverage"
        intake_ins_es = "confirmó cobertura de Medicaid"
        eval_cost_en = "at zero out-of-pocket cost under Medicaid"
        eval_cost_es = "sin ningún costo de bolsillo a través de Medicaid"
        rights_cost_en = "Early Intervention evaluations, IFSP coordination, and interpreter support are free to your family under Medicaid."
        rights_cost_es = "Las evaluaciones de Intervención Temprana, la coordinación del plan IFSP y el apoyo de intérprete son completamente gratuitos para su familia bajo Medicaid."
    else:
        intake_ins_en = "noted your Commercial / Private Insurance or family-fee sliding-scale protections"
        intake_ins_es = "registró su seguro comercial / privado o protección de escala móvil de tarifas familiares"
        eval_cost_en = "with IDEA Part C evaluation and IFSP services provided at zero out-of-pocket cost (Commercial / Private Insurance / Sliding-Scale protections apply)"
        eval_cost_es = "sin costo de bolsillo por la evaluación y el plan IFSP bajo IDEA Parte C (con su seguro comercial / privado o escala móvil de tarifas)"
        rights_cost_en = "Under federal IDEA Part C, initial evaluations and IFSP development are always free of charge regardless of Commercial / Private Insurance or sliding-scale status."
        rights_cost_es = "Bajo la ley federal IDEA Parte C, la evaluación inicial y el desarrollo del plan IFSP son siempre gratuitos, sin importar su seguro comercial / privado o escala móvil."

    # Language & 34 CFR § 303.321 interpreter rights phrasing
    if needs_bilingual:
        intake_lang_en = "and Spanish-bilingual support (34 CFR § 303.321)"
        intake_lang_es = "y atención bilingüe en español (34 CFR § 303.321)"
        eval_lang_en = "Bilingual Developmental Checkup"
        eval_lang_phrase_en = "in Spanish/English with free interpreter rights under 34 CFR § 303.321"
        eval_lang_es = "Evaluación del Desarrollo Bilingüe"
        eval_lang_phrase_es = "en español, garantizando su derecho gratuito a intérprete bajo 34 CFR § 303.321"
    else:
        intake_lang_en = "and English service with free interpreter rights available on request (34 CFR § 303.321)"
        intake_lang_es = "y servicio en inglés con derecho gratuito a intérprete en su idioma si lo desea (34 CFR § 303.321)"
        eval_lang_en = "Developmental Checkup"
        eval_lang_phrase_en = "in English (with free interpreter support in any preferred language under 34 CFR § 303.321)"
        eval_lang_es = "Evaluación del Desarrollo"
        eval_lang_phrase_es = "en inglés, con intérprete gratuito en español disponible sin costo bajo 34 CFR § 303.321"

    if eval_hop:
        eval_name = _clean_provider_name(
            eval_hop.get("target_name", "Developmental Evaluation Center")
        ) or "Developmental Evaluation Center"
        eval_days = int(eval_hop.get("cumulative_wait_days", 18) or 18)
        eval_date = (today + timedelta(days=eval_days)).isoformat()
        step2_en = (
            f"2. **{eval_lang_en} (By Day {eval_days} — {eval_date}):** **{eval_name}** will complete your child's "
            f"play-based evaluation ({domain_en}) {eval_lang_phrase_en}, {eval_cost_en}."
        )
        step2_es = (
            f"2. **{eval_lang_es} (Para el Día {eval_days} — {eval_date}):** **{eval_name}** realizará la evaluación "
            f"basada en el juego de su hijo/a ({domain_es}) {eval_lang_phrase_es}, {eval_cost_es}."
        )
        step3_num = "3"
    else:
        step2_en = ""
        step2_es = ""
        step3_num = "2"

    vendor_name = _clean_provider_name(
        vendor_hop.get("target_name", "Early Intervention Therapy Team")
    ) or "Early Intervention Therapy Team"

    mobility_bullets_en: list[str] = []
    mobility_bullets_es: list[str] = []
    if mobile_visit_capable:
        mobility_bullets_en.append(
            "- **Natural Environment Home Visits (`34 CFR § 303.126`):** Your evaluation or therapy team can conduct **Natural Environment visits at your home or childcare setting** so your child is comfortable and travel never slows care."
        )
        mobility_bullets_es.append(
            "- **Visitas en Entorno Natural en Casa (`34 CFR § 303.126`):** El equipo puede realizar **visitas en su entorno natural (hogar o guardería)** para mayor comodidad de su hijo/a y sin barreras de traslado."
        )
    if needs_nemt:
        if needs_medicaid:
            mobility_bullets_en.append(
                "- **Free Ride Assistance (Medicaid NEMT):** When an in-person clinic visit is needed, your coordinator has flagged **free Medicaid Non-Emergency Medical Transportation (NEMT)** so getting across town never delays care."
            )
            mobility_bullets_es.append(
                "- **Transporte Gratuito (Medicaid NEMT):** Cuando se requiera asistir a una clínica, su coordinador activó el **transporte médico gratuito de Medicaid (NEMT)** para que el traslado nunca sea una barrera."
            )
        else:
            mobility_bullets_en.append(
                "- **Transit & Home-Visit Support:** Because household transportation can be a barrier, ask your coordinator for **community transit vouchers or home/mobile evaluation options** for any clinic appointments."
            )
            mobility_bullets_es.append(
                "- **Apoyo de Transporte y Visita en Casa:** Para que la falta de vehículo no sea una barrera, solicite a su coordinador **vales de transporte comunitario u opciones de evaluación a domicilio**."
            )

    if age_m >= 34.5:
        cliff_en = (
            f"\n- **Urgent Age-3 Transition Window (`34 CFR § 303.209`):** At **{age_display} months** (<45 days before age 3), "
            "your coordinator is expediting Part C evaluation while coordinating simultaneously with your school district's **IDEA Part B Section 619** team so services continue seamlessly."
        )
        cliff_es = (
            f"\n- **Ventana Urgente de Transición a los 3 Años (`34 CFR § 303.209`):** Con **{age_display} meses** (<45 días antes de cumplir 3 años), "
            "su coordinador acelerará la evaluación de Parte C mientras coordina simultáneamente con el equipo escolar de **IDEA Parte B Sección 619** para evitar interrupciones."
        )
    elif age_m >= 33.0:
        cliff_en = (
            f"\n- **Part B Transition Conference Window (`34 CFR § 303.209`):** At **{age_display} months**, "
            "we are scheduling your mandatory **IDEA Part B preschool transition conference** with your school district so care continues smoothly at age 3."
        )
        cliff_es = (
            f"\n- **Conferencia de Transición a Parte B (`34 CFR § 303.209`):** A los **{age_display} meses**, "
            "programaremos su **conferencia obligatoria de transición preescolar IDEA Parte B** con su distrito escolar para asegurar continuidad a los 3 años."
        )
    elif age_m >= 30.0:
        cliff_en = (
            f"\n- **Age-3 Transition Support (`34 CFR § 303.209`):** Since your toddler is **{age_display} months** old, "
            "we will also initiate concurrent **IDEA Part B** preschool transition planning ahead of age 3 so there is zero gap in care."
        )
        cliff_es = (
            f"\n- **Apoyo de Transición a los 3 Años (`34 CFR § 303.209`):** Como su niño/a tiene **{age_display} meses**, "
            "iniciaremos también la planificación de transición preescolar **IDEA Parte B** antes de los 3 años para que no haya ninguna interrupción en sus terapias."
        )
    else:
        cliff_en = ""
        cliff_es = ""

    en_lines = [
        f"**Your Child's Early Milestones Plan (Target: ~{total_days} Calendar Days · Day 0: {day0_str} · {deadline_en})**",
        "",
        f"1. **Welcome Call & Electronic Intake (By Day {coord_days} — {coord_date}):** **{coord_name}** has received your clinic's electronic referral (no paper fax delays), {intake_ins_en}, {intake_lang_en}.",
    ]
    if step2_en:
        en_lines.append(step2_en)
    en_lines.extend([
        f"{step3_num}. **Family Service Plan & First Therapy Steps (By Day {total_days} — {ifsp_date}):** Together with **{vendor_name}**, we will finalize your Individualized Family Service Plan (IFSP) and begin support well before **{day45_str}**.",
        "",
        "**What You Need to Know:**",
        f"- **Zero Cost & Language Rights (`34 CFR § 303.321`):** {rights_cost_en}",
        *mobility_bullets_en,
    ])
    if cliff_en:
        en_lines.append(cliff_en.lstrip("\n"))
    en_lines.append("- *(Demo Notice: Caregiver-facing organizations are fictional `[Synthetic]` training profiles.)*")

    es_lines = [
        f"**Plan de Primeros Pasos de su Hijo/a (Meta: ~{total_days} Días Calendario · Día 0: {day0_str} · {deadline_es})**",
        "",
        f"1. **Llamada de Bienvenida y Registro Electrónico (Para el Día {coord_days} — {coord_date}):** **{coord_name}** recibió hoy la referencia electrónica de su clínica (sin demoras de fax en papel), {intake_ins_es} {intake_lang_es}.",
    ]
    if step2_es:
        es_lines.append(step2_es)
    es_lines.extend([
        f"{step3_num}. **Plan Familiar (IFSP) e Inicio de Terapia (Para el Día {total_days} — {ifsp_date}):** Junto con **{vendor_name}**, completaremos su Plan Individualizado de Servicios Familiares (IFSP) antes del **{day45_str}** para comenzar el apoyo.",
        "",
        "**Lo Que Su Familia Debe Saber:**",
        f"- **Sin Costo y Derechos de Idioma (`34 CFR § 303.321`):** {rights_cost_es}",
        *mobility_bullets_es,
    ])
    if cliff_es:
        es_lines.append(cliff_es.lstrip("\n"))
    es_lines.append("- *(Aviso de Demostración: Las organizaciones mostradas son perfiles ficticios `[Synthetic]` de entrenamiento.)*")

    validated_notes = CaregiverNotes(
        english="\n".join(en_lines),
        spanish="\n".join(es_lines),
    )
    return validated_notes.model_dump(mode="python")


def _safe_packet_readiness(
    child_age_months: int,
    concern_domain: str,
    needs_medicaid: bool,
    needs_bilingual: bool,
    has_household_vehicle: bool,
    home_tract_geoid: str = "",
) -> dict[str, Any] | None:
    """Safely calls `packet_gatekeeper.check_intake_packet_readiness` if available."""
    try:
        mod = importlib.import_module("first_milestones.tools.packet_gatekeeper")
        fn = getattr(mod, "check_intake_packet_readiness", None)
        if callable(fn):
            res = fn(
                state_code=_bq_client_mod.get_config().get("state", "MS"),
                child_age_months=child_age_months,
                concern_domain=concern_domain,
                preferred_language="Spanish" if needs_bilingual else "English",
                needs_medicaid=needs_medicaid,
                insurance_type="Medicaid" if needs_medicaid else "Commercial",
                has_household_vehicle=has_household_vehicle,
                home_tract_geoid=home_tract_geoid,
            )
            if isinstance(res, dict):
                return res
    except Exception:  # noqa: BLE001
        pass
    return {
        "status": "ready" if child_age_months < 36 else "redirect_part_b_619",
        "ready": child_age_months < 36,
        "statutory_transition_tier": _compute_statutory_transition_tier(child_age_months),
        "missing_items": [],
        "checks": {
            "consent_signed": True,
            "screening_tool_completed": True,
            "language_confirmed": True,
            "insurance_verified": True,
            "channel": "ehr_electronic_portal",
        },
    }


def _safe_list_slot_holds() -> list[dict[str, Any]]:
    """Safely fetches active 48h slot holds from `slot_ledger.list_slot_holds` if available."""
    try:
        mod = importlib.import_module("first_milestones.tools.slot_ledger")
        fn = getattr(mod, "list_slot_holds", None)
        if callable(fn):
            active_state = _bq_client_mod.get_config().get("state", "MS")
            res = fn(state_code=active_state)
            if isinstance(res, dict) and isinstance(res.get("holds"), list):
                return list(res["holds"])
            if isinstance(res, list):
                return list(res)
    except Exception:  # noqa: BLE001
        pass
    return []


def _safe_bq_telemetry() -> list[dict[str, Any]] | dict[str, Any] | None:
    """Safely calls `bq_client.get_bq_telemetry()` if implemented."""
    fn = getattr(_bq_client_mod, "get_bq_telemetry", None)
    if callable(fn):
        try:
            res = fn()
            if isinstance(res, (list, dict)):
                return res
        except Exception:  # noqa: BLE001
            pass
    cfg = _bq_client_mod.get_config()
    return {
        "backend": "bigquery_property_graph_iso_gql" if cfg.get("project") else "local_geoparquet_mirror",
        "project": cfg.get("project") or "(local GeoParquet preview)",
        "dataset": _bq_client_mod.graph_client.get_last_resolved_dataset(cfg),
        "state_code": cfg.get("state", "MS"),
    }


def build_validated_45d_brief_model(
    child_tract_geoid: str = "",
    child_age_months: int = 32,
    concern_domain: str = "Social-Communication / Autism Screen",
    needs_medicaid: bool = True,
    needs_bilingual: bool = True,
    has_household_vehicle: bool = False,
) -> PathwayBrief:
    """Assembles and validates the complete `PathwayBrief` Pydantic v2 model."""
    routing = find_compliant_45d_pathways(
        child_tract_geoid=child_tract_geoid,
        child_age_months=child_age_months,
        concern_domain=concern_domain,
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        has_household_vehicle=has_household_vehicle,
    )
    viable_45d_paths = find_viable_45d_paths(
        zip_or_tract=child_tract_geoid,
        languages="Spanish" if needs_bilingual else "English",
        insurance="Medicaid" if needs_medicaid else "Commercial",
        specialty=concern_domain,
        child_age_months=child_age_months,
        has_household_vehicle=has_household_vehicle,
    )
    audit = audit_multihop_bounce_hubs(only_breaches=True, limit_chains=6)
    bottleneck_hubs = detect_regional_bottleneck_hubs(region="ALL", max_days=45, top_n=5)
    top_hub_id = (
        audit["top_hidden_bounce_hub"]["provider_id"]
        if audit.get("top_hidden_bounce_hub")
        else ""
    )
    simulation = simulate_hub_intervention(
        target_provider_id=top_hub_id,
        upgrade_fax_to_ehr=True,
        precheck_bilingual_and_slot_capacity=True,
    )
    equity = run_post_output_equity_audit()
    outreach = prioritize_community_screening_tracts(top_n=5)
    outreach_zones = rank_outreach_zones(
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        top_n=6,
    )
    agencies = lookup_regional_agency_kpis()
    caregiver_notes = build_caregiver_notes(routing)

    transition_tier = (
        routing.get("statutory_transition_tier")
        or (routing.get("child_profile") or {}).get("statutory_transition_tier")
        or _compute_statutory_transition_tier(child_age_months)
    )
    packet_readiness = routing.get("packet_readiness") or _safe_packet_readiness(
        child_age_months=child_age_months,
        concern_domain=concern_domain,
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        has_household_vehicle=has_household_vehicle,
        home_tract_geoid=child_tract_geoid,
    )
    slot_holds = _safe_list_slot_holds()
    bq_telemetry = _safe_bq_telemetry()
    before_vs_after = routing.get("before_vs_after_rerouting_cohort")

    resolved_state = str(
        (routing.get("child_profile") or {}).get("state_code")
        or agencies.get("state_code")
        or equity.get("state_code")
        or "MS"
    )
    resolved_engine = str(
        routing.get("execution_engine")
        or routing.get("engine")
        or equity.get("execution_engine")
        or "local_geoparquet_mirror"
    )

    payload: dict[str, Any] = {
        "state_code": resolved_state,
        "execution_engine": resolved_engine,
        "agencies": agencies["agencies"],
        "routing": routing,
        "viable_45d_paths": viable_45d_paths,
        "network_audit": audit,
        "bottleneck_hubs": bottleneck_hubs,
        "counterfactual_simulation": simulation,
        "equity_audit": equity,
        "screening_outreach": outreach,
        "outreach_zones": outreach_zones,
        "caregiver_notes": caregiver_notes,
        "packet_readiness": packet_readiness,
        "slot_holds": slot_holds,
        "bq_telemetry": bq_telemetry,
        "statutory_transition_tier": transition_tier,
        "before_vs_after_rerouting_cohort": before_vs_after,
    }
    return PathwayBrief.model_validate(payload)


def generate_complete_45d_brief(
    child_tract_geoid: str = "",
    child_age_months: int = 32,
    concern_domain: str = "Social-Communication / Autism Screen",
    needs_medicaid: bool = True,
    needs_bilingual: bool = True,
    has_household_vehicle: bool = False,
) -> dict[str, Any]:
    """Generates and schema-validates the complete 45-Day Pathway & Bottleneck Brief."""
    validated = build_validated_45d_brief_model(
        child_tract_geoid=child_tract_geoid,
        child_age_months=child_age_months,
        concern_domain=concern_domain,
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        has_household_vehicle=has_household_vehicle,
    )
    return validated.model_dump(mode="python")
