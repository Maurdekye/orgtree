"""Narrow instrumentation controls; no product server or PG needed."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

REPO=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(REPO/'tools/scale'))
from loaded_cpu import Meter, CTX

class CpuControls(unittest.TestCase):
    def test_cpu_excludes_sleep_and_records_busy_work(self):
        with tempfile.TemporaryDirectory() as root:
            meter=Meter(root); meter.enabled=True
            meter.measured('worker',time.sleep,.08)
            self.assertLess(meter.cpu['worker:background'],.03)
            def busy():
                start=time.thread_time()
                while time.thread_time()-start<.05: sum(range(100))
            token=CTX.set({'kind':'tool:control'})
            try: meter.measured('worker',busy)
            finally: CTX.reset(token)
            self.assertGreaterEqual(meter.cpu['worker:tool:control'],.04)
            self.assertTrue(any(i[2]=='busy' for i in meter.functions['worker:tool:control']))

    def test_overlapping_workers_keep_running_when_sample_busy(self):
        with tempfile.TemporaryDirectory() as root:
            meter=Meter(root); meter.enabled=True; meter.every=1
            entered=threading.Event(); release=threading.Event(); seen=[]
            def first():
                entered.set(); release.wait(2)
            thread=threading.Thread(target=lambda:meter.measured('worker',first))
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                meter.measured('worker',lambda:seen.append('second finished'))
                self.assertEqual(seen,['second finished'])
                self.assertEqual(meter.skipped_samples['worker:background'],1)
            finally:
                release.set(); thread.join(3)

    def test_nested_boundary_does_not_double_count(self):
        with tempfile.TemporaryDirectory() as root:
            meter=Meter(root); meter.enabled=True
            meter.measured('worker',lambda: meter.measured('worker',lambda:None))
            self.assertEqual(meter.count['worker:background'],1)

    def test_anyio_keeps_worker_and_context(self):
        import anyio.to_thread
        old=anyio.to_thread.run_sync; old_handle=asyncio.Handle._run
        class Routes:
            def get(self,path): return lambda fn: fn
        async def app(scope,receive,send):
            await receive()
            seen.append(await anyio.to_thread.run_sync(lambda:(threading.get_ident(),CTX.get()['kind'])))
            await send({'type':'http.response.start','status':200})
        async def received(): return {'type':'http.request','body':b'{"tool":"orgtree_work","args":{"action":"update"}}'}
        async def sent(message): pass
        seen=[]
        with tempfile.TemporaryDirectory() as root:
            meter=Meter(root); meter.enabled=True; meter.install_sql=lambda:None
            wrapped=meter.install(app,Routes())
            try: asyncio.run(wrapped({'type':'http','path':'/api/agent'},received,sent))
            finally:
                anyio.to_thread.run_sync=old; asyncio.Handle._run=old_handle
            self.assertNotEqual(seen[0][0],threading.get_ident())
            self.assertEqual(seen[0][1],'tool:orgtree_work:update')
            self.assertEqual(meter.count['worker:tool:orgtree_work:update'],1)
            self.assertTrue(any(r['type']=='request' and r['status']==200 for r in meter.events))

if __name__=='__main__': unittest.main()
