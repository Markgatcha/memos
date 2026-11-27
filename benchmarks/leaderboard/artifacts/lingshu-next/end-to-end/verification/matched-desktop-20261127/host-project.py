"""Stream only the organizer fields required to ingest the benchmark."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project import PRODUCT, iter_projections, session_time

dataset, limit = Path(sys.argv[1]), int(sys.argv[2])
for ordinal, row in enumerate(iter_projections(dataset, PRODUCT | {"question_id"}), 1):
    histories = [
        {
            "ordinal": index,
            "at": session_time(date),
            "messages": [[message["role"], message["content"]] for message in messages],
        }
        for index, (date, messages) in enumerate(
            zip(row["haystack_dates"], row["haystack_sessions"], strict=True)
        )
    ]
    item = {
        "ordinal": ordinal,
        "question_id": row["question_id"],
        "question": row["question"],
        "questionDate": row["question_date"],
        "histories": sorted(histories, key=lambda history: (history["at"], history["ordinal"])),
    }
    print(json.dumps(item, ensure_ascii=True, separators=(",", ":")))
    if ordinal == limit:
        break
else:
    raise ValueError("Dataset ended before the expected limit")
