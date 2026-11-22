#!/usr/bin/env python3
"""PreInvocation hook for instant 0-token /чат and /ctx context reporting."""

import json
import os
import subprocess
import sys

COMMANDS = {"/чат", "/ctx", "/chat", "/tokens"}


def fmt_num(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def resolve_language() -> str:
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


def compute_stats(transcript_path: str) -> dict:
    steps = []
    all_time_peak = 0
    segment_peak = 0
    pending_compaction = False
    compaction_count = 0

    with open(transcript_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue

            if entry.get("type") == "CHECKPOINT":
                compaction_count += 1
                pending_compaction = True
                segment_peak = 0
                continue

            if isinstance(entry.get("input_tokens"), (int, float)):
                in_tok = int(entry.get("input_tokens") or 0)
                cache_tok = int(entry.get("cache_read_tokens") or 0)
                total = in_tok + cache_tok

                if pending_compaction:
                    pending_compaction = False
                    segment_peak = total
                elif segment_peak > 0:
                    drop = segment_peak - total
                    if drop > 25000 and (drop / segment_peak) > 0.30:
                        compaction_count += 1
                        segment_peak = total
                    else:
                        if total > segment_peak:
                            segment_peak = total
                else:
                    segment_peak = total

                if total > all_time_peak:
                    all_time_peak = total

                steps.append(
                    {
                        "total": total,
                        "in": in_tok,
                        "cache": cache_tok,
                        "out": int(entry.get("output_tokens") or 0),
                        "step_index": entry.get("step_index", len(steps) + 1),
                        "model": entry.get("model") or "",
                    }
                )

    if not steps:
        return {"empty": True}

    last = steps[-1]
    prev_total = steps[-2]["total"] if len(steps) >= 2 else 0
    delta = last["total"] - prev_total if len(steps) >= 2 else last["total"]

    return {
        "empty": False,
        "total": last["total"],
        "in": last["in"],
        "cache": last["cache"],
        "peak": all_time_peak,
        "delta": delta,
        "step_index": last["step_index"],
        "model": last["model"],
        "compaction_count": compaction_count,
    }


def format_message(stats: dict | None, lang: str) -> str:
    if not stats or stats.get("empty"):
        return "Контекст: 0 токенов" if lang == "ru" else "Context: 0 tokens"

    total = stats["total"]
    delta = stats["delta"]
    sign = "+" if delta >= 0 else ""

    if lang == "ru":
        parts = [
            f"Контекст: {fmt_num(total)} токенов ({sign}{fmt_num(delta)})",
            f"кэш: {fmt_num(stats['cache'])}",
            f"шаг: {stats['step_index']}",
        ]
        if stats["compaction_count"] > 0:
            parts.append(f"сжатий: {stats['compaction_count']}×")
    else:
        parts = [
            f"Context: {fmt_num(total)} tokens ({sign}{fmt_num(delta)})",
            f"cache: {fmt_num(stats['cache'])}",
            f"step: {stats['step_index']}",
        ]
        if stats["compaction_count"] > 0:
            parts.append(f"compactions: {stats['compaction_count']}×")

    return " · ".join(parts)


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        print("{}")
        return

    last_input = (payload.get("lastUserInput") or "").strip()
    if not last_input or last_input.lower() not in COMMANDS:
        print("{}")
        return

    lang = resolve_language()
    tp = resolve_transcript(payload)
    stats = compute_stats(tp) if tp else None
    msg = format_message(stats, lang)

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
