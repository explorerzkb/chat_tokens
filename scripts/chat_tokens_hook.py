#!/usr/bin/env python3
"""PreInvocation hook for instant 0-token /чат and /ctx context reporting."""

import json
import os
import sys

COMMANDS = {"/чат", "/ctx", "/chat", "/tokens"}


def fmt_num(n: int) -> str:
    return f"{n:,}".replace(",", " ")


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
    peak = 0
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
            if isinstance(entry.get("input_tokens"), (int, float)):
                in_tok = int(entry.get("input_tokens") or 0)
                cache_tok = int(entry.get("cache_read_tokens") or 0)
                total = in_tok + cache_tok
                if peak > 0:
                    drop = peak - total
                    if drop > 25000 and (drop / peak) > 0.30:
                        compaction_count += 1
                if total > peak:
                    peak = total
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
        "peak": peak,
        "delta": delta,
        "step_index": last["step_index"],
        "model": last["model"],
        "compaction_count": compaction_count,
    }


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

    tp = resolve_transcript(payload)
    if not tp:
        msg = "Контекст: 0 токенов"
    else:
        stats = compute_stats(tp)
        if stats.get("empty"):
            msg = "Контекст: 0 токенов"
        else:
            total = stats["total"]
            delta = stats["delta"]
            sign = "+" if delta >= 0 else ""
            parts = [
                f"Контекст: {fmt_num(total)} токенов ({sign}{fmt_num(delta)})",
                f"кэш: {fmt_num(stats['cache'])}",
                f"шаг: {stats['step_index']}",
            ]
            if stats["compaction_count"] > 0:
                parts.append(f"сжатий: {stats['compaction_count']}×")
            msg = " · ".join(parts)

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
