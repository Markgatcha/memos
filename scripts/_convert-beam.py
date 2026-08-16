import pandas as pd, json, ast, os, sys

parquet_path = sys.argv[1]
json_path = sys.argv[2]

df = pd.read_parquet(parquet_path)
convs = []
for _, row in df.iterrows():
    rd = {c: json.loads(json.dumps(row[c], default=str)) for c in df.columns}
    turns = []
    chat = row["chat"]
    for pi, plan in enumerate(chat):
        for t in plan:
            turns.append({
                "id": t.get("id", ""),
                "role": t.get("role", "user"),
                "content": t.get("content", ""),
                "index": t.get("index", 0),
                "question_type": t.get("question_type", ""),
                "time_anchor": t.get("time_anchor", 0),
                "plan_idx": pi,
            })
    cs = row["conversation_seed"]
    cs_d = ast.literal_eval(cs) if isinstance(cs, str) else (cs if isinstance(cs, dict) else {})
    pq_raw = rd["probing_questions"]
    pqs = []
    ak = ["preference_following", "instruction_following", "information_extraction",
          "knowledge_update", "multi_session_reasoning", "summarization",
          "temporal_reasoning", "event_ordering", "abstention", "contradiction_resolution"]
    if isinstance(pq_raw, dict):
        for k in ak:
            if k in pq_raw:
                items = pq_raw[k] if isinstance(pq_raw[k], list) else [pq_raw[k]]
                for q in items:
                    pqs.append({
                        "ability": k,
                        "question": q.get("question", ""),
                        "ideal_response": q.get("ideal_response", q.get("ideal_answer", q.get("answer", q.get("ideal_summary", "")))),
                        "source_chat_ids": q.get("source_chat_ids", []),
                        "difficulty": q.get("difficulty", "unknown"),
                    })
    elif isinstance(pq_raw, str):
        pd_dict = ast.literal_eval(pq_raw)
        for k in ak:
            if k in pd_dict:
                for q in pd_dict[k]:
                    pqs.append({
                        "ability": k,
                        "question": q.get("question", ""),
                        "ideal_response": q.get("ideal_response", q.get("ideal_answer", q.get("answer", q.get("ideal_summary", "")))),
                        "source_chat_ids": q.get("source_chat_ids", []),
                        "difficulty": q.get("difficulty", "unknown"),
                    })
    convs.append({
        "conversation_id": rd["conversation_id"],
        "category": cs_d.get("category", "unknown"),
        "theme": cs_d.get("theme", "unknown"),
        "title": cs_d.get("title", "unknown"),
        "narratives": rd["narratives"],
        "user_profile": rd["user_profile"],
        "chat_turns": turns,
        "probing_questions": pqs,
    })

print(f"  {len(convs)} conversations, {sum(len(c['probing_questions']) for c in convs)} questions")
json.dump(convs, open(json_path, "w"))
print(f"  Saved to {json_path} ({round(os.path.getsize(json_path)/1024/1024,1)}MB)")
