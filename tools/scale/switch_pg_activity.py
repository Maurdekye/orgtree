"""Read-only holder/waiter snapshots from this disposable root's database."""
import argparse
import json
from pathlib import Path
import time
import psycopg
from psycopg.rows import dict_row

p=argparse.ArgumentParser()
p.add_argument('--root',required=True)
args=p.parse_args()
root=Path(args.root).resolve()
desc=json.loads((root/'scale-descriptor.json').read_text())
with psycopg.connect(desc['pg_url'], autocommit=True, connect_timeout=5,
        options='-c default_transaction_read_only=on -c statement_timeout=3000', row_factory=dict_row) as conn:
    with (root/'metrics'/'pg-holder-waiter.jsonl').open('w',encoding='utf8',buffering=1) as out:
        while not (root/'metrics'/'stop-pg-observer').exists():
            row={'at':time.time()}
            try:
                row['activity']=conn.execute('''SELECT pid,application_name,state,xact_start,query_start,
                    wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,left(query,2048) AS query
                    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()''').fetchall()
                row['locks']=conn.execute('''SELECT pid,locktype,mode,granted,virtualtransaction,
                    transactionid,database,relation,classid,objid,objsubid FROM pg_locks
                    WHERE pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database()
                                  AND pid<>pg_backend_pid())''').fetchall()
            except Exception as exc:
                row['error']=f'{type(exc).__name__}: {exc}'
            out.write(json.dumps(row,default=str)+'\n')
            time.sleep(2)
