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
from loaded_cpu import Meter, CTX, ThreadClocks

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
                def external_only(): seen.append('second finished')
                meter.measured('worker',external_only)
                self.assertEqual(seen,['second finished'])
                self.assertEqual(meter.count['worker:background'],2)
            finally:
                release.set(); thread.join(3)


    def test_yappi_separates_thread_tags_and_excludes_sleep(self):
        with tempfile.TemporaryDirectory() as root:
            meter=Meter(root); meter.setup_yappi()
            entered=threading.Event(); release=threading.Event()
            def sleeping_first():
                token=CTX.set({'kind':'first'})
                try:
                    entered.set(); release.wait(2)
                finally: CTX.reset(token)
            def busy_second():
                begun=time.thread_time()
                while time.thread_time()-begun<.05: sum(range(100))
            thread=threading.Thread(target=sleeping_first)
            meter.yappi.start(builtins=True,profile_threads=True)
            try:
                thread.start(); self.assertTrue(entered.wait(1))
                token=CTX.set({'kind':'second'})
                try: busy_second()
                finally: CTX.reset(token)
            finally:
                release.set(); thread.join(3); meter.yappi.stop()
            first=list(meter.yappi.get_func_stats(tag=meter.tags['first']))
            second=list(meter.yappi.get_func_stats(tag=meter.tags['second']))
            self.assertFalse(any(r.name=='busy_second' for r in first))
            busy=next(r for r in second if r.name=='busy_second')
            self.assertGreaterEqual(busy.ttot,.035)
            self.assertLess(sum(r.tsub for r in first),.03)
            meter.yappi.clear_stats()

    def test_single_window_cpu_does_not_charge_stopped_gap(self):
        with tempfile.TemporaryDirectory() as root:
            meter=Meter(root); meter.setup_yappi()
            token=CTX.set({'kind':'single'})
            def work():
                start=time.thread_time()
                while time.thread_time()-start<.05: sum(range(100))
            try:
                start=time.process_time()
                meter.yappi.start(builtins=True,profile_threads=True)
                work(); meter.yappi.stop()
                cpu=time.process_time()-start
                work()  # deliberately outside the ONLY profiling interval
                rows=list(meter.yappi.get_func_stats(tag=meter.tags['single']))
                self.assertLessEqual(sum(r.tsub for r in rows),cpu+.025)
                self.assertGreater(sum(r.tsub for r in rows),.025)
            finally:
                CTX.reset(token); meter.yappi.stop(); meter.yappi.clear_stats()

    def test_cached_windows_thread_clock_counts_cpu_and_closes(self):
        clocks=ThreadClocks(); tid=threading.get_native_id()
        try:
            before=clocks.read([tid])[tid]
            begun=time.thread_time()
            while time.thread_time()-begun<.05: sum(range(100))
            after=clocks.read([tid])[tid]
            self.assertGreaterEqual(after-before,.04)
            self.assertLess(after-before,.15)
        finally: clocks.close()
        self.assertFalse(clocks.handles)

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
