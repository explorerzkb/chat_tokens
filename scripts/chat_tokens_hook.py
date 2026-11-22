#!/usr/bin/env python3
"""PreInvocation hook for instant 0-token /чат and /ctx context reporting."""

from __future__ import annotations

from datetime import datetime
import json
import os
import re
import subprocess
import sys

COMMANDS = {"/чат", "/ctx", "/chat", "/tokens"}
PREFS_PATH = os.path.expanduser("~/.gemini/config/chat_tokens_prefs.json")

MODEL_SELECTION_RE = re.compile(
    r"changed setting `Model Selection` from ([^\n]+?) to ([^\n.]+(?:\.[^\n.]*)*?)\."
)
EFFORT_PATTERNS = (
    re.compile(r"\s*\((x?high|medium|low)\)\s*$", re.IGNORECASE),
    re.compile(r"-(x?high|medium|low)$", re.IGNORECASE),
    re.compile(r"\s+(x?high|medium|low)$", re.IGNORECASE),
)
ORCH_WRAPPER_RE = re.compile(r"^orchestrator\s*\(([^)]+)\)$", re.IGNORECASE)
DIGIT_DASH_RE = re.compile(r"(?<=\d)-(?=\d)")
EFFORT_SUFFIX_PAREN_RE = re.compile(r"\s*\((x?high|medium|low)\)", re.IGNORECASE)
EFFORT_SUFFIX_DASH_RE = re.compile(r"-(x?high|medium|low)$", re.IGNORECASE)

FILE_TOOLS = {
    "read_file",
    "view_file",
    "edit_file",
    "write_file",
    "write_to_file",
    "replace_file_content",
}
DROP_MODEL_TOKENS = {
    "gemini",
    "claude",
    "anthropic",
    "google",
    "agy",
    "orchestrator",
    "worker",
}


def fmt_num(n: int) -> str:
    return f"{int(n):,}".replace(",", " ")


def fmt_k(n: int) -> str:
    return f"{round(int(n) / 1000)}k"


def fmt_compact(n: int) -> str:
    v = int(n)
    if v >= 1_000_000:
        if v % 1_000_000 == 0:
            return f"{v // 1_000_000}M"
        return f"{v / 1_000_000:.1f}M"
    if v >= 1000:
        return fmt_k(v)
    return str(v)


def fmt_duration(secs: int, lang: str) -> str:
    if secs <= 0:
        return "—"
    if secs < 60:
        return "<1м" if lang == "ru" else "<1m"
    total_min = secs // 60
    days = total_min // (24 * 60)
    hours = (total_min % (24 * 60)) // 60
    mins = total_min % 60
    if days > 0:
        return f"{days}д {hours}ч" if lang == "ru" else f"{days}d {hours}h"
    if hours > 0:
        return f"{hours}ч {mins}м" if lang == "ru" else f"{hours}h {mins}m"
    return f"{mins}м" if lang == "ru" else f"{mins}m"


def parse_threshold_input(raw: str) -> int | None:
    cleaned = raw.strip().lower().replace(" ", "").replace("_", "").replace(",", ".")
    if not cleaned:
        return None
    mult = 1
    if cleaned.endswith(("m", "м")):
        mult = 1_000_000
        cleaned = cleaned[:-1]
    elif cleaned.endswith(("k", "к")):
        mult = 1_000
        cleaned = cleaned[:-1]
    try:
        num = float(cleaned)
    except ValueError:
        return None
    if num <= 0:
        return None
    tokens = round(num * mult)
    return min(max(tokens, 10_000), 10_000_000)


def read_prefs() -> dict:
    defaults = {"threshold": 200_000, "language": None, "historyMode": "messages"}
    try:
        with open(PREFS_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return defaults
    if not isinstance(raw, dict):
        return defaults

    th = raw.get("threshold")
    if isinstance(th, (int, float)) and 10_000 <= th <= 10_000_000:
        defaults["threshold"] = int(round(th))
    lang = raw.get("language")
    if lang in ("ru", "en"):
        defaults["language"] = lang
    hm = raw.get("historyMode")
    if hm in ("messages", "steps"):
        defaults["historyMode"] = hm
    return defaults


def resolve_language(prefs: dict) -> str:
    pref_lang = prefs.get("language")
    if pref_lang in ("ru", "en"):
        return pref_lang

    for env_key in ("LC_ALL", "LC_MESSAGES", "LANG"):
        val = (os.environ.get(env_key) or "").lower()
        if val.startswith("ru"):
            return "ru"
        if val.startswith("en"):
            return "en"

    if sys.platform == "darwin":
        try:
            res = subprocess.run(
                ["defaults", "read", "-g", "AppleLanguages"],
                capture_output=True,
                text=True,
                timeout=1,
            )
            if res.returncode == 0 and '"ru' in res.stdout.lower():
                return "ru"
        except Exception:
            pass

    return "en"


def resolve_transcript(payload: dict) -> str | None:
    tp = payload.get("transcriptPath")
    if isinstance(tp, str) and tp and os.path.isfile(tp):
        return tp

    conv_id = payload.get("conversationId") or ""
    if conv_id:
        base = os.path.expanduser(
            f"~/.gemini/antigravity/brain/{conv_id}/.system_generated/logs"
        )
        for name in ("transcript.jsonl", "transcript_full.jsonl"):
            candidate = os.path.join(base, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def strip_effort_suffix(raw: str) -> str:
    s = EFFORT_SUFFIX_PAREN_RE.sub("", raw)
    s = EFFORT_SUFFIX_DASH_RE.sub("", s)
    return s.strip()


def normalized_model_key(raw: str) -> str:
    no_effort = strip_effort_suffix(raw).lower()
    cleaned = no_effort.replace("(", " ").replace(")", " ").replace(".", "-")
    return "-".join(part for part in cleaned.split() if part)


def format_model_display(raw: str) -> tuple[str, str | None]:
    trimmed = raw.strip()
    if not trimmed:
        return ("", None)

    work = trimmed
    effort = None
    for pat in EFFORT_PATTERNS:
        m = pat.search(work)
        if m:
            raw_eff = m.group(1).lower()
            effort = {"xhigh": "XHigh", "high": "High", "medium": "Medium", "low": "Low"}.get(raw_eff)
            work = work[: m.start()].strip()
            break

    orch_m = ORCH_WRAPPER_RE.match(work)
    if orch_m:
        work = orch_m.group(1).strip()

    work = DIGIT_DASH_RE.sub(".", work.replace("(", " ").replace(")", " "))
    raw_tokens = [tok for tok in re.split(r"[-_\s]+", work) if tok]
    filtered = [tok for tok in raw_tokens if tok.lower() not in DROP_MODEL_TOKENS]
    chosen = filtered if filtered else raw_tokens

    formatted = []
    for tok in chosen:
        if tok == tok.lower() and any(ch.isalpha() for ch in tok):
            formatted.append(tok[0].upper() + tok[1:])
        else:
            formatted.append(tok)

    name = " ".join(formatted) or trimmed
    return (name, effort)


def is_compaction_marker(step_type: str, source: str, content: str) -> bool:
    if step_type == "CHECKPOINT":
        return True
    if step_type == "SYSTEM_MESSAGE" or source == "SYSTEM":
        if (
            "<plan>" in content
            or "Plan mode is off" in content
            or "[plan review" in content
            or "[Message] timestamp=" in content
        ):
            return False
        return (
            "Resuming from a compaction" in content
            or "lost access to the full conversation history" in content
            or "This conversation grew too large" in content
            or "history before this point may be missing or incomplete" in content
            or "{{ CHECKPOINT" in content
            or "earlier parts of this conversation have been truncated" in content
        )
    return False


def extract_touched_file_name(call: dict) -> str | None:
    args = call.get("args") or call.get("arguments")
    if not isinstance(args, dict):
        return None
    for key in ("Path", "AbsolutePath", "TargetFile", "File", "path"):
        raw = args.get(key)
        if isinstance(raw, str) and raw:
            cleaned = raw.strip().strip("\"'")
            name = os.path.basename(cleaned)
            if name:
                return name
    return None


def looks_like_file_output(text: str) -> bool:
    return (
        text.startswith("Showing lines ")
        or text.startswith("File Path: ")
        or text.startswith("Made ")
        or text.startswith("Created file")
        or ("Showing lines " in text and "Completed At:" in text)
    )


def looks_like_command_output(text: str) -> bool:
    return (
        text.startswith("Command exited")
        or text.startswith("Tool is running as a background task")
        or "Command exited with code" in text
    )


def parse_ts_ms(raw: str) -> float | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def compute_stats(transcript_path: str) -> dict:
    total_steps = 0
    user_turns = 0
    current_turn_index = 0
    all_time_peak = 0
    segment_peak = 0

    pending_compaction = False
    pending_model_switch = False
    pending_effort_switch = False
    pending_phase_change = False
    compaction_count = 0

    current_ui_model = ""
    last_recorded_effective_model = ""
    last_raw_step_model_in_segment = ""
    has_orchestrator = False
    has_manual = False
    current_segment_orch = False

    total_in = 0
    total_cache = 0
    total_out = 0
    first_ts = None
    last_ts = None

    first_model_total = None
    first_user_chars = 0
    user_chars = 0
    assistant_chars = 0
    thinking_chars = 0
    files_chars = 0
    tools_chars = 0
    system_chars = 0
    history_chars = 0
    checkpoint_chars = 0
    last_step_file_tool_ratio = 0.0

    tool_name_counts: dict[str, int] = {}
    file_name_counts: dict[str, int] = {}
    model_step_counts: dict[str, int] = {}
    model_last_idx: dict[str, int] = {}

    model_steps_count = 0
    last_step = None
    prev_step_context = 0

    # Turn tracking for message-level metrics
    current_turn_id = 0
    current_turn_steps = 0
    current_turn_end_tokens = 0
    current_turn_sum_in = 0
    current_turn_sum_cache = 0
    current_turn_last_cache = 0
    prev_turn_end_tokens = 0
    last_msg_delta = 0
    last_msg_cache = 0
    last_msg_cache_pct = 0
    finalized_turns = 0

    def finalize_turn() -> None:
        nonlocal prev_turn_end_tokens, last_msg_delta, last_msg_cache, last_msg_cache_pct
        nonlocal current_turn_steps, finalized_turns
        if current_turn_steps <= 0:
            return
        last_msg_delta = current_turn_end_tokens - prev_turn_end_tokens
        prev_turn_end_tokens = current_turn_end_tokens
        denom = current_turn_sum_in + current_turn_sum_cache
        last_msg_cache_pct = round((current_turn_sum_cache / denom) * 100) if denom > 0 else 0
        last_msg_cache = current_turn_last_cache
        finalized_turns += 1
        current_turn_steps = 0

    def reset_breakdown_chars() -> None:
        nonlocal user_chars, assistant_chars, thinking_chars, files_chars
        nonlocal tools_chars, system_chars, history_chars, checkpoint_chars
        user_chars = 0
        assistant_chars = 0
        thinking_chars = 0
        files_chars = 0
        tools_chars = 0
        system_chars = 0
        history_chars = 0
        checkpoint_chars = 0

    with open(transcript_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            # Fast pre-filter: skip JSON decoding on heavy GENERIC tool-output rows
            if (
                ('"type":"GENERIC"' in line or '"type": "GENERIC"' in line)
                and '"input_tokens"' not in line
            ):
                total_steps += 1
                approx_chars = max(0, len(line) - 140)
                if (
                    "Showing lines " in line
                    or "File Path: " in line
                    or "Made " in line
                    or "Created file" in line
                ):
                    files_chars += approx_chars
                elif (
                    "Command exited" in line
                    or "Tool is running as a background task" in line
                ):
                    tools_chars += approx_chars
                elif last_step_file_tool_ratio >= 0.99:
                    files_chars += approx_chars
                elif last_step_file_tool_ratio <= 0.01:
                    tools_chars += approx_chars
                else:
                    f_part = round(approx_chars * last_step_file_tool_ratio)
                    files_chars += f_part
                    tools_chars += approx_chars - f_part
                continue

            try:
                entry = json.loads(line)
            except Exception:
                continue
            if not isinstance(entry, dict):
                continue

            total_steps += 1
            step_type = entry.get("type") or ""
            source = entry.get("source") or ""
            content = entry.get("content") if isinstance(entry.get("content"), str) else ""

            ts = parse_ts_ms(entry.get("created_at"))
            if ts is not None:
                if first_ts is None:
                    first_ts = ts
                last_ts = ts

            if is_compaction_marker(step_type, source, content):
                if not pending_compaction:
                    compaction_count += 1
                    pending_compaction = True
                segment_peak = 0
                reset_breakdown_chars()
                checkpoint_chars = len(content)
                if isinstance(entry.get("input_tokens"), (int, float)):
                    in_tok = int(entry.get("input_tokens") or 0)
                    cache_tok = int(entry.get("cache_read_tokens") or 0)
                    out_tok = int(entry.get("output_tokens") or 0)
                    all_time_peak = max(all_time_peak, in_tok + cache_tok)
                    total_in += in_tok
                    total_cache += cache_tok
                    total_out += out_tok
                continue

            has_exit_plan = False
            has_enter_plan = False

            if step_type == "USER_INPUT":
                user_turns += 1
                current_turn_index = user_turns
                user_chars += len(content)
                if first_model_total is None:
                    first_user_chars += len(content)
                if "Model Selection" in content:
                    for m in MODEL_SELECTION_RE.finditer(content):
                        from_m = m.group(1).strip()
                        to_m = m.group(2).strip()
                        if not from_m or not to_m:
                            continue
                        if from_m.lower() == "none":
                            if not current_ui_model:
                                current_ui_model = to_m
                                if "orchestrator" in to_m.lower():
                                    current_segment_orch = True
                            continue
                        if from_m == to_m:
                            continue
                        from_base = normalized_model_key(from_m)
                        to_base = normalized_model_key(to_m)
                        if from_base == to_base and from_base:
                            pending_effort_switch = True
                            current_ui_model = to_m
                        else:
                            pending_model_switch = True
                            last_raw_step_model_in_segment = ""
                            current_segment_orch = "orchestrator" in to_m.lower()
                            current_ui_model = to_m
            elif step_type == "PLANNER_RESPONSE":
                assistant_chars += len(content)
                thinking = entry.get("thinking")
                if isinstance(thinking, str):
                    thinking_chars += len(thinking)
                tool_calls = entry.get("tool_calls")
                if isinstance(tool_calls, list):
                    file_calls = 0
                    for call in tool_calls:
                        if not isinstance(call, dict):
                            continue
                        name = call.get("name") or ""
                        call_chars = len(json.dumps(call, ensure_ascii=False))
                        if name:
                            tool_name_counts[name] = tool_name_counts.get(name, 0) + 1
                            if name == "exit_plan_mode":
                                has_exit_plan = True
                            elif name == "enter_plan_mode":
                                has_enter_plan = True
                        fname = extract_touched_file_name(call)
                        if fname:
                            file_name_counts[fname] = file_name_counts.get(fname, 0) + 1
                        if name in FILE_TOOLS:
                            files_chars += call_chars
                            file_calls += 1
                        else:
                            tools_chars += call_chars
                    last_step_file_tool_ratio = (
                        file_calls / len(tool_calls) if tool_calls else 0.0
                    )
                else:
                    last_step_file_tool_ratio = 0.0
            elif step_type == "SYSTEM_MESSAGE":
                system_chars += len(content)
                if "Plan mode is off" in content or "[plan review" in content:
                    current_segment_orch = True
                    pending_phase_change = True
            elif step_type == "EPHEMERAL_MESSAGE":
                system_chars += len(content)
            elif step_type == "CONVERSATION_HISTORY":
                history_chars += len(content)
            elif step_type in ("VIEW_FILE", "CODE_ACTION"):
                files_chars += len(content)
            elif step_type in (
                "RUN_COMMAND",
                "SEARCH_WEB",
                "LIST_DIRECTORY",
                "GREP_SEARCH",
                "READ_URL_CONTENT",
                "ERROR_MESSAGE",
            ):
                tools_chars += len(content)
            elif step_type == "GENERIC":
                if looks_like_file_output(content):
                    files_chars += len(content)
                elif looks_like_command_output(content):
                    tools_chars += len(content)
                elif last_step_file_tool_ratio >= 0.99:
                    files_chars += len(content)
                elif last_step_file_tool_ratio <= 0.01:
                    tools_chars += len(content)
                else:
                    f_part = round(len(content) * last_step_file_tool_ratio)
                    files_chars += f_part
                    tools_chars += len(content) - f_part

            if has_exit_plan or has_enter_plan:
                current_segment_orch = True

            if isinstance(entry.get("input_tokens"), (int, float)):
                in_tok = int(entry.get("input_tokens") or 0)
                cache_tok = int(entry.get("cache_read_tokens") or 0)
                out_tok = int(entry.get("output_tokens") or 0)
                total = in_tok + cache_tok
                raw_step_model = entry.get("model") if isinstance(entry.get("model"), str) else ""
                effective_model = raw_step_model or current_ui_model

                if raw_step_model:
                    if (
                        last_raw_step_model_in_segment
                        and last_raw_step_model_in_segment != raw_step_model
                        and not pending_model_switch
                        and not pending_effort_switch
                    ):
                        current_segment_orch = True
                        pending_phase_change = True
                    last_raw_step_model_in_segment = raw_step_model

                if current_segment_orch:
                    has_orchestrator = True
                else:
                    has_manual = True

                if pending_compaction:
                    pending_compaction = False
                    segment_peak = total
                elif segment_peak >= 100_000:
                    drop = segment_peak - total
                    same_model = (
                        not last_recorded_effective_model
                        or effective_model == last_recorded_effective_model
                    )
                    if (
                        not pending_model_switch
                        and not pending_effort_switch
                        and not pending_phase_change
                        and same_model
                        and (drop / segment_peak) >= 0.75
                    ):
                        compaction_count += 1
                        segment_peak = total
                        reset_breakdown_chars()
                    else:
                        segment_peak = max(segment_peak, total)
                else:
                    segment_peak = max(segment_peak, total)

                if total > all_time_peak:
                    all_time_peak = total

                if first_model_total is None:
                    first_model_total = total

                total_in += in_tok
                total_cache += cache_tok
                total_out += out_tok

                if effective_model:
                    model_step_counts[effective_model] = model_step_counts.get(effective_model, 0) + 1
                    model_last_idx[effective_model] = model_steps_count

                step_delta = total - prev_step_context if model_steps_count > 0 else total
                prev_step_context = total
                step_idx = entry.get("step_index")
                if not isinstance(step_idx, int):
                    step_idx = total_steps

                last_step = {
                    "total": total,
                    "in": in_tok,
                    "cache": cache_tok,
                    "out": out_tok,
                    "delta": step_delta,
                    "cache_pct": round((cache_tok / total) * 100) if total > 0 else 0,
                    "step_index": step_idx,
                    "model": effective_model,
                }
                model_steps_count += 1

                turn_id = max(1, current_turn_index)
                if current_turn_steps > 0 and turn_id != current_turn_id:
                    finalize_turn()
                if current_turn_steps == 0:
                    current_turn_id = turn_id
                    current_turn_sum_in = 0
                    current_turn_sum_cache = 0
                current_turn_steps += 1
                current_turn_end_tokens = total
                current_turn_sum_in += in_tok
                current_turn_sum_cache += cache_tok
                current_turn_last_cache = cache_tok

                pending_model_switch = False
                pending_effort_switch = False
                pending_phase_change = False
                last_recorded_effective_model = effective_model

            if has_exit_plan or has_enter_plan:
                pending_phase_change = True

    finalize_turn()

    if not last_step:
        return {"empty": True}

    # Build 6-category breakdown scaled to current contextTokens
    last_total = last_step["total"]
    base_sys_est = (
        min(max(first_model_total - (first_user_chars // 4), 0), min(last_total, 35_000))
        if first_model_total is not None
        else 0
    )
    raw_sys = base_sys_est + (system_chars // 4) + (history_chars // 4) + (checkpoint_chars // 4)
    raw_files = files_chars // 4
    raw_tools = tools_chars // 4
    raw_assistant = assistant_chars // 4
    raw_thinking = thinking_chars // 4
    raw_user = user_chars // 4
    raw_sum = raw_sys + raw_files + raw_tools + raw_assistant + raw_thinking + raw_user

    if last_total <= 0:
        breakdown = {"system": 0, "files": 0, "tools": 0, "assistant": 0, "thinking": 0, "user": 0}
    elif raw_sum <= 0:
        breakdown = {"system": last_total, "files": 0, "tools": 0, "assistant": 0, "thinking": 0, "user": 0}
    else:
        scale = last_total / raw_sum
        sys_tok = round(raw_sys * scale)
        files_tok = round(raw_files * scale)
        tools_tok = round(raw_tools * scale)
        asst_tok = round(raw_assistant * scale)
        think_tok = round(raw_thinking * scale)
        user_tok = max(0, last_total - sys_tok - files_tok - tools_tok - asst_tok - think_tok)
        breakdown = {
            "system": sys_tok,
            "files": files_tok,
            "tools": tools_tok,
            "assistant": asst_tok,
            "thinking": think_tok,
            "user": user_tok,
        }

    sorted_models = sorted(
        model_step_counts.items(),
        key=lambda kv: (kv[1], model_last_idx.get(kv[0], -1)),
        reverse=True,
    )
    primary_model = sorted_models[0][0] if sorted_models else last_step["model"]
    other_models_count = max(0, len(sorted_models) - 1)
    session_denom = total_in + total_cache
    avg_cache_pct = round((total_cache / session_denom) * 100) if session_denom > 0 else 0
    duration_secs = (
        round(last_ts - first_ts) if first_ts is not None and last_ts is not None and last_ts >= first_ts else 0
    )

    top_files = sorted(file_name_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    top_tools = sorted(tool_name_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]

    return {
        "empty": False,
        "total": last_step["total"],
        "in": last_step["in"],
        "cache": last_step["cache"],
        "cache_pct": last_step["cache_pct"],
        "delta": last_step["delta"],
        "step_index": last_step["step_index"],
        "msg_delta": last_msg_delta,
        "msg_cache": last_msg_cache,
        "msg_cache_pct": last_msg_cache_pct,
        "user_message_count": max(user_turns, finalized_turns),
        "total_model_steps": model_steps_count,
        "peak": all_time_peak,
        "compaction_count": compaction_count,
        "primary_model": primary_model,
        "other_models_count": other_models_count,
        "has_orchestrator": has_orchestrator,
        "has_manual": has_manual,
        "total_in": total_in,
        "total_out": total_out,
        "avg_cache_pct": avg_cache_pct,
        "duration_secs": duration_secs,
        "breakdown": breakdown,
        "top_files": top_files,
        "top_tools": top_tools,
    }


def format_message(stats: dict | None, lang: str, threshold: int, history_mode: str) -> str:
    if not stats or stats.get("empty"):
        return "🟢 Контекст: 0 токенов" if lang == "ru" else "🟢 Context: 0 tokens"

    total = stats["total"]
    pct = min(999, round((total / threshold) * 100)) if threshold > 0 else 0
    zone_dot = "🔴" if pct >= 85 else ("🟡" if pct >= 65 else "🟢")

    if history_mode == "steps":
        delta = stats["delta"]
        cache_pct = stats["cache_pct"]
        counter_str = (
            f"шаг {stats['step_index']}" if lang == "ru" else f"step {stats['step_index']}"
        )
    else:
        delta = stats["msg_delta"]
        cache_pct = stats["msg_cache_pct"]
        counter_str = (
            f"сообщ. {stats['user_message_count']}"
            if lang == "ru"
            else f"msg {stats['user_message_count']}"
        )

    sign = "+" if delta >= 0 else ""
    model_name, effort = format_model_display(stats["primary_model"])
    model_short = model_name or "—"
    if effort:
        model_short += f" ({effort})"

    compact_tail = f" · ⚡ {stats['compaction_count']}×" if stats["compaction_count"] > 0 else ""

    if lang == "ru":
        return (
            f"{zone_dot} Контекст: {fmt_num(total)} / {fmt_compact(threshold)} ({pct}%) "
            f"· {sign}{fmt_num(delta)} · кэш {cache_pct}% · {model_short} · {counter_str}{compact_tail}"
        )

    return (
        f"{zone_dot} Context: {fmt_num(total)} / {fmt_compact(threshold)} ({pct}%) "
        f"· {sign}{fmt_num(delta)} · cache {cache_pct}% · {model_short} · {counter_str}{compact_tail}"
    )


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        print("{}")
        return

    last_input = (payload.get("lastUserInput") or "").strip()
    if not last_input:
        print("{}")
        return

    tokens = last_input.split()
    if not tokens or tokens[0].lower() not in COMMANDS or len(tokens) > 2:
        print("{}")
        return

    prefs = read_prefs()
    threshold = prefs["threshold"]
    if len(tokens) == 2:
        override = parse_threshold_input(tokens[1])
        if override is None:
            print("{}")
            return
        threshold = override

    lang = resolve_language(prefs)
    tp = resolve_transcript(payload)
    stats = compute_stats(tp) if tp else None
    msg = format_message(stats, lang, threshold, prefs["historyMode"])

    out = {
        "injectSteps": [
            {
                "errorMessage": {
                    "userMessage": msg,
                }
            }
        ],
        "terminationBehavior": "terminate",
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
