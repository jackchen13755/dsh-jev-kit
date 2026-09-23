#!/usr/bin/env python3
"""Reference Laya server for dsh-jev-kit's `laya` engine.

The kit speaks one deliberately boring HTTP contract, so any Laya wrapper
(PyTorch, ONNX, MLX) can serve the benchmark with a script this size:

    GET  /health   → 200 {"ok": true}
    POST /         ← {"state": {...}, "questions": {...}}
                   → {"answers": {"<key>": {"noul": 0.93}}, "ms": 32.8}

The question primitives are the same three the kit uses — `noul`, `choice`,
`score` — because Laya's published interface is the same typed-decision shape:

    noul   → P(true)
    choice → one option key from `criteria`
    score  → expected value over an ordered `criteria` list

Install and run:

    # Needs Python 3.10+ (ModernBERT and current transformers reject 3.9).
    python3 -m venv .venv && . .venv/bin/activate
    pip install laya
    python3 scripts/laya-server.py --port 8791

    # then, in the harness:
    jev_kit_bench { engines: ["jev", "laya"] }

Notes that matter for a fair comparison:

  · ``--checkpoint`` picks the weights. ``laya`` (English, ModernBERT-large, 512
    tokens) is the default; ``laya-multilingual`` handles 100+ languages at 1024
    tokens; ``laya-typed-decisions`` is fine-tuned on that benchmark's own training
    split and will look better than it is on your own fixtures.
  · ``--temperature`` applies the calibration the model card says you owe it:
    Laya ships over-confident (raw ECE 0.21–0.47), and the published 0.081 ECE
    comes *after* fitting one temperature per (question type, option count) on your
    data. The kit's separation metric is threshold-free, so a missing temperature
    does not flatter or punish it — the thresholded pass rate would.
  · Keep choice questions under ~20 options at the default head budget: options
    share a fixed token budget, which is exactly the high-cardinality case Jev wins.
"""
from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DEFAULT_PORT = 8791


def build_agent(checkpoint: str, temperature: float | None):
    """Load the checkpoint once, at startup — a per-request reload costs seconds."""
    try:
        import laya  # type: ignore
    except ImportError as error:  # pragma: no cover - operator-facing message
        raise SystemExit(
            "laya is not installed. Needs Python 3.10+:\n"
            "  python3 -m venv .venv && . .venv/bin/activate && pip install laya\n"
            f"(import error: {error})"
        ) from error
    agent = laya.load(checkpoint)
    if temperature is not None:
        try:
            agent.cfg["temperature"] = temperature
        except Exception:  # noqa: BLE001 - older builds have no such knob
            print("warning: this Laya build exposes no `temperature` knob; serving raw logits")
    return agent


def to_laya_questions(questions: dict[str, Any]) -> dict[str, Any]:
    """The kit's question schema is already Laya's; only `criteria` needs care.

    `noul` carries a {true,false} wording pair in the kit (it is what makes the
    polarity auditable). Laya's `noul` takes just `instructions`, so the wording is
    folded in rather than dropped: the reader of a probability should still be able
    to see which direction "true" pointed.
    """
    out: dict[str, Any] = {}
    for key, question in questions.items():
        kind = question.get("type")
        if kind == "noul":
            criteria = question.get("criteria") or {}
            instructions = question.get("instructions", "")
            if isinstance(criteria, dict) and criteria:
                instructions = (
                    f"{instructions} Answer true if: {criteria.get('true', 'yes')}. "
                    f"Answer false if: {criteria.get('false', 'no')}."
                )
            out[key] = {"type": "noul", "instructions": instructions}
        elif kind == "choice":
            out[key] = {
                "type": "choice",
                "instructions": question.get("instructions", ""),
                "criteria": question.get("criteria") or {},
            }
        elif kind == "score":
            out[key] = {
                "type": "score",
                "instructions": question.get("instructions", ""),
                "criteria": question.get("criteria") or [],
            }
        else:
            raise ValueError(f"unsupported question type: {kind!r}")
    return out


def normalise_answers(raw: Any, questions: dict[str, Any]) -> dict[str, Any]:
    """Return the kit's answer shape whatever the SDK hands back.

    Accepts either ``{key: {"noul": 0.9}}`` (already normalised) or the SDK's
    ``result["answers"]`` mapping, and coerces by the *question type* so a build
    that returns a bare float for a `noul` still produces a scored answer instead
    of an empty verdict.
    """
    if isinstance(raw, dict) and "answers" in raw and isinstance(raw["answers"], dict):
        raw = raw["answers"]
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in raw.items():
        kind = (questions.get(key) or {}).get("type")
        if isinstance(value, dict):
            if kind == "noul" and "noul" not in value:
                for field in ("probability", "p", "score", "value"):
                    if isinstance(value.get(field), (int, float)):
                        value = {"noul": float(value[field])}
                        break
            out[key] = value
        elif isinstance(value, (int, float)):
            out[key] = {"noul": float(value)} if kind == "noul" else (
                {"score": float(value)} if kind == "score" else {"choice": str(value)}
            )
        else:
            out[key] = {"choice": value} if kind == "choice" else {"noul": float(value)}
    return out


def make_handler(agent: Any, verbose: bool):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - http.server's interface
            if self.path.rstrip("/") in ("/health", ""):
                self._send(200, {"ok": True, "checkpoint": getattr(agent, "name", "laya")})
            else:
                self._send(404, {"ok": False, "error": f"unknown route {self.path}"})

        def do_POST(self) -> None:  # noqa: N802
            try:
                length = int(self.headers.get("content-length") or 0)
                request = json.loads(self.rfile.read(length) or b"{}")
                state = request.get("state") or {}
                questions = to_laya_questions(request.get("questions") or {})
                started = time.perf_counter()
                result = agent.predict(state, questions)
                elapsed_ms = (time.perf_counter() - started) * 1000
                answers = normalise_answers(result, request.get("questions") or {})
                if verbose:
                    print(f"  → {len(answers)} answers in {elapsed_ms:.1f} ms")
                self._send(200, {"answers": answers, "ms": round(elapsed_ms, 1)})
            except Exception as error:  # noqa: BLE001 - surface it, never a silent empty answer
                self._send(500, {"ok": False, "error": f"{type(error).__name__}: {error}"})

        def log_message(self, fmt: str, *args: Any) -> None:  # keep the console readable
            if verbose:
                print(f"[laya-server] {fmt % args}")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Laya over the dsh-jev-kit contract")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--checkpoint", default="convaiinnovations/laya",
                        help="laya | convaiinnovations/laya-multilingual | convaiinnovations/laya-typed-decisions")
    parser.add_argument("--temperature", type=float, default=None,
                        help="temperature fitted on your own data; omit to serve raw logits")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    agent = build_agent(args.checkpoint, args.temperature)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(agent, args.verbose))
    print(f"laya-server listening on http://{args.host}:{args.port} · checkpoint={args.checkpoint}")
    print("kit setting: engines = [\"jev\", \"laya\"] (layaEndpoint defaults to this address)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
