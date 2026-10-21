#!/usr/bin/env python3
"""SQLite execution worker for the libSQL mock pipeline server.

WHY THIS FILE EXISTS
    The portal store's contract test has to prove that the SQL the libSQL
    adapter emits behaves the way the store interface promises. A canned
    response can only prove the WIRE FORMAT; only a real SQL engine can prove
    the SEMANTICS.

    libSQL is a fork of SQLite, so the dialect is the same. This worker uses
    the SQLite that ships with the Python standard library (no pip install, no
    npm dependency, nothing added to the repo's dependency graph) and speaks
    the libSQL HTTP v2 value format over stdin/stdout.

PROTOCOL (newline-delimited JSON, one request per line, one answer per line)

    ->  {"op": "exec", "sql": "SELECT …", "args": [ <Value>, … ]}
    <-  {"cols": [{"name": "data"}], "rows": [ [ <Value>, … ] ],
         "affected_row_count": 0}

    ->  {"op": "reset"}          <- {"ok": true}      (fresh, empty database)
    ->  {"op": "close"}          (the worker exits)

A Value is the libSQL/Hrana shape:
    {"type": "null"}
    {"type": "integer", "value": "42"}      (integers travel as strings)
    {"type": "float",   "value": 1.5}
    {"type": "text",    "value": "…"}
    {"type": "blob",    "base64": "…"}
"""

import base64
import json
import sqlite3
import sys


def encode(value):
    """A Python value -> the libSQL value shape."""
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        # SQLite has no boolean: it stores 0/1. The adapter compares the TEXT
        # form ('true'/'false'), so the worker keeps the distinction explicit.
        return {"type": "integer", "value": "1" if value else "0"}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(bytes(value)).decode("ascii")}
    return {"type": "text", "value": str(value)}


def decode(arg):
    """A libSQL value -> a Python value."""
    if not isinstance(arg, dict):
        return arg
    kind = arg.get("type")
    if kind == "null":
        return None
    if kind == "integer":
        raw = arg.get("value")
        return int(raw) if raw is not None else 0
    if kind == "float":
        raw = arg.get("value")
        return float(raw) if raw is not None else 0.0
    if kind == "blob":
        return base64.b64decode(arg.get("base64") or arg.get("value") or "")
    if kind == "text":
        raw = arg.get("value")
        return None if raw is None else str(raw)
    return arg


class Worker:
    def __init__(self, path=None):
        self.path = path
        self.db = None
        self.open_db()

    def open_db(self):
        if self.db is not None:
            self.db.close()
        self.db = sqlite3.connect(self.path or ":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")

    def execute(self, sql, args):
        cursor = self.db.execute(sql, [decode(a) for a in (args or [])])
        columns = []
        if cursor.description:
            columns = [{"name": str(d[0]), "decltype": None} for d in cursor.description]
        rows = [[encode(v) for v in row] for row in cursor.fetchall()]
        changes = 0
        if "returning" in sql.lower():
            # With RETURNING the changed rows are the returned rows.
            changes = len(rows)
        elif cursor.rowcount is not None and cursor.rowcount > 0:
            changes = cursor.rowcount
        return {"cols": columns, "rows": rows, "affected_row_count": changes}


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    worker = Worker(path)
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception as err:  # a broken line must not kill the worker
            out.write(json.dumps({"error": {"message": str(err), "code": "BAD_JSON"}}) + "\n")
            out.flush()
            continue

        op = message.get("op")
        try:
            if op == "exec":
                answer = worker.execute(message.get("sql", ""), message.get("args"))
            elif op == "reset":
                worker.open_db()
                answer = {"ok": True}
            elif op == "close":
                out.write(json.dumps({"ok": True}) + "\n")
                out.flush()
                return
            else:
                answer = {"error": {"message": "unknown op %r" % (op,), "code": "UNKNOWN_OP"}}
        except Exception as err:
            answer = {"error": {"message": str(err), "code": type(err).__name__}}
        out.write(json.dumps(answer) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
