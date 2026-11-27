import json
import mmap
import re
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PRODUCT = {"question", "question_date", "haystack_sessions", "haystack_dates"}
SCORER = {"question_id", "question_type", "question", "answer"}
STR = re.compile(rb'"(?:[^"\\]|\\.)*"', re.DOTALL)
STRUCTURE = re.compile(rb'"(?:[^"\\]|\\.)*"|[\[\]{}]', re.DOTALL)
ATOMIC_END = re.compile(rb"[,}\]\s]")
WHITESPACE = re.compile(rb"\s*")


def iter_projections(filename: Path, fields: set[str]) -> Iterator[dict[str, Any]]:
    with (
        filename.open("rb") as handle,
        mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as source,
    ):

        def skip(index: int) -> int:
            return WHITESPACE.match(source, index).end()

        def end_value(index: int) -> int:
            if source[index] == ord('"'):
                return STR.match(source, index).end()
            if source[index] not in b"[{":
                return ATOMIC_END.search(source, index).start()
            stack = []
            for match in STRUCTURE.finditer(source, index):
                char = source[match.start()]
                if char in b"[{":
                    stack.append(char)
                elif char in b"]}":
                    if not stack or (stack.pop(), char) not in ((91, 93), (123, 125)):
                        raise ValueError("Mismatched JSON delimiter")
                    if not stack:
                        return match.end()
            raise ValueError("Unterminated JSON")

        offset = skip(0)
        assert source[offset] == ord("[")
        offset = skip(offset + 1)
        while source[offset] != ord("]"):
            assert source[offset] == ord("{")
            offset = skip(offset + 1)
            projection = {}
            while source[offset] != ord("}"):
                key_end = STR.match(source, offset).end()
                key = json.loads(source[offset:key_end])
                separator = skip(key_end)
                assert source[separator] == ord(":")
                start = skip(separator + 1)
                stop = end_value(start)
                if key in fields:
                    projection[key] = json.loads(source[start:stop])
                offset = skip(stop)
                if source[offset] == ord(","):
                    offset = skip(offset + 1)
            if projection.keys() != fields:
                raise ValueError("Missing projection fields")
            yield projection
            offset = skip(offset + 1)
            if source[offset] == ord(","):
                offset = skip(offset + 1)


def session_time(value: str) -> int:
    date = datetime.fromisoformat(
        re.sub(r" \([A-Za-z]{3,9}\)", "", value).strip().replace("/", "-")
    )
    if date.tzinfo is None:
        date = date.replace(tzinfo=UTC)
    return int(date.timestamp() * 1000)


def main() -> None:
    mode = sys.argv[1]
    if mode not in {"product", "score"} or len(sys.argv) != 4:
        raise ValueError("Expected a projection mode and a dataset path")
    limit = int(sys.argv[3])
    file = Path(sys.argv[2])
    projection = PRODUCT if mode == "product" else SCORER
    for index, row in enumerate(iter_projections(file, projection), 1):
        if mode == "product":
            histories = [
                {
                    "ordinal": ordinal,
                    "at": session_time(date),
                    "messages": [[message["role"], message["content"]] for message in messages],
                }
                for ordinal, (date, messages) in enumerate(
                    zip(row["haystack_dates"], row["haystack_sessions"], strict=True)
                )
            ]
            record = {
                "ordinal": index,
                "question": row["question"],
                "questionDate": row["question_date"],
                "histories": histories,
            }
        else:
            record = {
                "ordinal": index,
                "questionId": row["question_id"],
                "task": row["question_type"],
                "question": row["question"],
                "answer": str(row["answer"]),
            }
        print(json.dumps(record, ensure_ascii=True, separators=(",", ":")))
        if index == limit:
            return


if __name__ == "__main__":
    main()
