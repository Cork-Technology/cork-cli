#!/usr/bin/env python3
"""Grade A/B transcripts: tool selection, parameter accuracy, error/confusion signals."""
import json, re, sys, glob, os

DIR = os.path.dirname(os.path.abspath(__file__))
TASKS = {t["id"]: t for t in json.load(open(f"{DIR}/tasks.json"))}

def get(d, path):
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur: return None
        cur = cur[part]
    return cur

def grade_run(task, path):
    calls, results, final = [], [], ""
    for line in open(path):
        line = line.strip()
        if not line: continue
        try: ev = json.loads(line)
        except json.JSONDecodeError: continue
        if ev.get("type") == "assistant":
            for c in ev.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    calls.append({"name": c.get("name", ""), "input": c.get("input", {})})
        elif ev.get("type") == "user":
            for c in ev.get("message", {}).get("content", []) if isinstance(ev.get("message", {}).get("content"), list) else []:
                if c.get("type") == "tool_result":
                    results.append(json.dumps(c.get("content", ""))[:4000])
        elif ev.get("type") == "result":
            final = ev.get("result", "") or ""
    exp = "mcp__cork__" + task["expect_tool"]
    cork_calls = [c for c in calls if c["name"].startswith("mcp__cork__")]
    first_ok = bool(cork_calls) and cork_calls[0]["name"] == exp
    # params: any single call to the expected tool satisfying ALL targets
    param_ok = False
    for c in cork_calls:
        if c["name"] != exp: continue
        ok = True
        for t in task.get("targets", []):
            k, v = t.split("=", 1)
            got = get(c["input"], k)
            if str(got) != v: ok = False; break
        if ok: param_ok = True; break
    invalid = sum(r.count("invalid_input") for r in results)
    answer_ok = True
    if task.get("answer_regex"):
        answer_ok = bool(re.search(task["answer_regex"], final))
    return {"first_tool_ok": first_ok, "params_ok": param_ok, "n_calls": len(cork_calls),
            "invalid_input_results": invalid, "answer_ok": answer_ok,
            "called": [c["name"].replace("mcp__cork__", "") for c in cork_calls],
            "no_calls": len(cork_calls) == 0}

def main(labels):
    table = {}
    for label in labels:
        for path in sorted(glob.glob(f"{DIR}/runs/{label}/*.jsonl")):
            tid = os.path.basename(path)[:-6]
            if tid not in TASKS: continue
            table.setdefault(tid, {})[label] = grade_run(TASKS[tid], path)
    hdr = f"{'task':32}" + "".join(f"{l:>26}" for l in labels)
    print(hdr); print("-" * len(hdr))
    agg = {l: {"sel": 0, "par": 0, "inv": 0, "ans": 0, "n": 0} for l in labels}
    for tid in TASKS:
        row = f"{tid:32}"
        for l in labels:
            g = table.get(tid, {}).get(l)
            if not g: row += f"{'(missing)':>26}"; continue
            mark = f"sel:{'Y' if g['first_tool_ok'] else 'N'} par:{'Y' if g['params_ok'] else 'N'} inv:{g['invalid_input_results']} c:{g['n_calls']}"
            if not g["answer_ok"]: mark += " ans:N"
            row += f"{mark:>26}"
            agg[l]["sel"] += g["first_tool_ok"]; agg[l]["par"] += g["params_ok"]
            agg[l]["inv"] += g["invalid_input_results"]; agg[l]["ans"] += g["answer_ok"]; agg[l]["n"] += 1
        print(row)
    print("-" * len(hdr))
    for l in labels:
        a = agg[l]
        if a["n"]: print(f"{l}: selection {a['sel']}/{a['n']}, params {a['par']}/{a['n']}, invalid_input results {a['inv']}, answer_ok {a['ans']}/{a['n']}")
    # detail dump for failures
    for tid in TASKS:
        for l in labels:
            g = table.get(tid, {}).get(l)
            if g and (not g["params_ok"] or not g["first_tool_ok"]):
                print(f"\n[{l}/{tid}] calls: {g['called']}")

if __name__ == "__main__":
    main(sys.argv[1:])
