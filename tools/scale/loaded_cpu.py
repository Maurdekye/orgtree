"""Measurement-only, concurrency-preserving CPU and transaction tracing.

CPU totals are thread_time at worker/callback boundaries. Function costs are a
deterministic sample, never wall time. OS-thread stack weights are estimates.
No product operation, scheduler policy, lock or SQL is changed.
"""
from __future__ import annotations
import asyncio
import collections
import contextvars

import functools
import json
import os
from pathlib import Path
import pstats
import sys
import threading
import time

CTX = contextvars.ContextVar('scale_cpu_request', default=None)


def label(ctx):
    return ctx.get('kind', 'unknown') if ctx else 'background'


class ThreadClocks:
    """Cache Windows thread handles; avoid enumerating all OS threads at10Hz."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes=ctypes; self.ft=wintypes.FILETIME
        self.kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        self.kernel.OpenThread.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        self.kernel.OpenThread.restype=wintypes.HANDLE
        self.kernel.GetThreadTimes.argtypes=[wintypes.HANDLE]+[ctypes.POINTER(self.ft)]*4
        self.kernel.GetThreadTimes.restype=wintypes.BOOL
        self.kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        self.handles={}
    def read(self,ids):
        out={}
        for tid in ids:
            handle=self.handles.get(tid)
            if not handle:
                handle=self.kernel.OpenThread(0x0800,False,tid)
                if not handle: continue
                self.handles[tid]=handle
            values=[self.ft() for _ in range(4)]
            if self.kernel.GetThreadTimes(handle,*[self.ctypes.byref(v) for v in values]):
                out[tid]=sum((v.dwHighDateTime<<32)|v.dwLowDateTime for v in values[2:])*1e-7
        return out
    def close(self):
        for handle in self.handles.values(): self.kernel.CloseHandle(handle)
        self.handles.clear()


class Meter:
    def __init__(self, root, every=10):
        self.root = Path(root)
        self.every = every
        self.enabled = False
        self.seq = 0
        self.tags = {}
        self.windows = []
        self.profile_on = False
        self.profile_epoch = 0
        self.cpu_modes = collections.Counter()
        self.count = collections.Counter()
        self.cpu = collections.Counter()
        self.sample_cpu = collections.Counter()
        self.functions = {}
        self.events = []
        self.local = threading.local()
        self.stack_cpu = collections.Counter()
        self.thread_cpu = collections.Counter()
        self.thread_names = {}
        self.stop = threading.Event()
        self.started = None
        self.finished = None

    def event(self, row):
        if self.enabled and len(self.events) < 150000:
            self.events.append(row)

    def measured(self, where, fn, *args, **kwargs):
        if not self.enabled or getattr(self.local, 'depth', 0):
            return fn(*args, **kwargs)
        ctx = CTX.get()
        key = where + ':' + label(ctx)
        self.count[key] += 1
        self.local.depth = 1
        start = time.thread_time()
        epoch = self.profile_epoch
        mode = 'profiled' if self.profile_on else 'plain'
        try:
            return fn(*args, **kwargs)
        finally:
            spent=time.thread_time()-start
            self.cpu[key]+=spent
            self.cpu_modes[(mode if epoch==self.profile_epoch else 'mixed')+':'+key]+=spent
            self.local.depth=0

    def setup_yappi(self):
        sys.path.insert(0,os.environ.get('ORGTREE_SCALE_YAPPI_PATH',
            r'C:\Users\ncola_k8bx\AppData\Local\Temp\orgtree-e-rows-scale\profiler313-deps'))
        import yappi
        yappi.clear_stats(); yappi.set_clock_type('cpu')
        def tag():
            ctx=CTX.get()
            key=label(ctx) if ctx else 'background:'+threading.current_thread().name
            value=self.tags.get(key)
            if value is None:
                value=len(self.tags)+1; self.tags[key]=value
            return value
        yappi.set_tag_callback(tag)
        self.yappi=yappi

    def sample_windows(self):
        # One contiguous interval: stop/start gaps can be accrued to open
        # native profiler frames, so never resume an earlier profile stack.
        if self.stop.wait(25): return
        self.yappi.clear_stats()
        self.profile_epoch+=1; self.profile_on=True
        window=dict(start=time.time(),process_start=time.process_time())
        self.yappi.start(builtins=True,profile_threads=True)
        self.stop.wait(30)
        self.yappi.stop()
        self.profile_on=False; self.profile_epoch+=1
        window.update(end=time.time(),process_end=time.process_time())
        self.windows.append(window)

    def start(self):
        if self.started: raise RuntimeError('one profile window per engine')
        self.setup_yappi()
        self.started = dict(wall=time.time(), process=time.process_time())
        self.enabled = True
        threading.Thread(target=self.sampler, name='scale-cpu-sampler', daemon=True).start()
        self.prof_thread=threading.Thread(target=self.sample_windows,name='scale-function-profiler',daemon=True)
        self.prof_thread.start()
        return self.started

    def finish(self):
        self.finished = dict(wall=time.time(), process=time.process_time())
        self.enabled = False
        self.stop.set()
        self.prof_thread.join(timeout=5)
        self.yappi.stop()
        function_stats={}
        for key,tag in list(self.tags.items()):
            function_stats[key]=[dict(file=r.module,line=r.lineno,function=r.name,
                calls=r.ncall,self_s=r.tsub,cumulative_s=r.ttot) for r in
                self.yappi.get_func_stats(tag=tag).sort('tsub')[:160]]
        sampled_self=sum(row['self_s'] for rows in function_stats.values() for row in rows)
        window_cpu=sum(w['process_end']-w['process_start'] for w in self.windows)
        conservation=sampled_self <= window_cpu*1.15+.1
        data = dict(function_cpu_valid=conservation, sampled_self_s=sampled_self, window_cpu_s=window_cpu, start=self.started, finish=self.finished, every=self.every,
            count=dict(self.count), cpu=dict(self.cpu), sampled_cpu=dict(self.sample_cpu),
            cpu_modes=dict(self.cpu_modes),windows=self.windows,profiler="yappi1.7.6-cpu",
            thread_cpu=dict(self.thread_cpu), thread_names=self.thread_names,
            weighted_stacks=[dict(key=k, cpu_s=v) for k,v in self.stack_cpu.most_common(300)],
            functions=function_stats,
            event_count=len(self.events), event_cap=150000)
        (self.root/'metrics'/'loaded-cpu.json').write_text(json.dumps(data,indent=2),encoding='utf8')
        with (self.root/'metrics'/'loaded-trace.jsonl').open('w',encoding='utf8') as out:
            for row in self.events: out.write(json.dumps(row)+'\n')
        return dict(events=len(self.events), classes=len(self.cpu), start=self.started, finish=self.finished)

    def sampler(self):
        clocks=ThreadClocks()
        previous={}
        try:
            while not self.stop.wait(.25):
                frames=sys._current_frames()
                threads={t.native_id:t for t in threading.enumerate() if t.native_id}
                for tid,value in clocks.read(threads).items():
                    delta=max(0,value-previous.get(tid,value)); previous[tid]=value
                    th=threads[tid]; key=str(tid)+':'+th.name
                    self.thread_names[str(tid)]=th.name
                    self.thread_cpu[key]+=delta
                    frame=frames.get(th.ident); stack=[]
                    while frame and len(stack)<16:
                        stack.append(f'{os.path.basename(frame.f_code.co_filename)}:{frame.f_code.co_name}:{frame.f_lineno}')
                        frame=frame.f_back
                    if delta: self.stack_cpu[key+'|'+';'.join(stack)]+=delta
        finally: clocks.close()

    def install(self, app, api_app):
        import anyio.to_thread
        real_run = anyio.to_thread.run_sync
        async def run_sync(fn, *args, **kwargs):
            queued = time.time()
            ctx = CTX.get()
            def job():
                started = time.time()
                try:
                    return self.measured('worker', fn, *args)
                finally:
                    self.event(dict(type='worker', queued=queued, start=started, end=time.time(),
                        request=ctx, native_id=threading.get_native_id()))
            return await real_run(job, **kwargs)
        anyio.to_thread.run_sync = run_sync
        real_handle = asyncio.Handle._run
        def handle_run(handle):
            ctx = handle._context.get(CTX, None)
            # Handle._run itself enters the handle context; enter only the label
            # around the meter, then let the original execute its own context.
            token = CTX.set(ctx)
            try: return self.measured('loop', real_handle, handle)
            finally: CTX.reset(token)
        asyncio.Handle._run = handle_run
        self.install_sql()
        from orgtree import store, orgtx
        for module, names in ((store, ('_load_sqlite_org', '_write_doc', '_load_section')),
                              (orgtx, ('_check_heal',))):
            for name in names:
                original = getattr(module, name)
                def phase(*args, _fn=original, _name=name, **kwargs):
                    if not self.enabled: return _fn(*args, **kwargs)
                    start=time.time(); cpu=time.thread_time()
                    try: return _fn(*args, **kwargs)
                    finally:
                        self.event(dict(type='phase',name=_name,start=start,end=time.time(),
                            cpu_s=time.thread_time()-cpu,request=CTX.get(),
                            native_id=threading.get_native_id()))
                setattr(module,name,functools.wraps(original)(phase))

        @api_app.get('/scale/cpu-start')
        async def cpu_start(): return self.start()
        @api_app.get('/scale/cpu-stop')
        async def cpu_stop(): return self.finish()

        async def wrapped(scope, receive, send):
            if scope['type'] not in ('http','websocket'):
                return await app(scope, receive, send)
            self.seq += 1
            path = scope.get('path','')
            kind = ('feed' if scope['type']=='websocket' or path=='/scale/stream' else
                    'steer' if 'steer' in path else 'tool' if path=='/api/agent' else
                    'instrumentation' if path.startswith('/scale/') else 'ui')
            ctx = dict(id=self.seq, path=path, kind=kind)
            token = CTX.set(ctx)
            start = time.time()
            status = [None]
            body = bytearray()
            async def received():
                message = await receive()
                if path=='/api/agent' and message['type']=='http.request':
                    body.extend(message.get('body',b''))
                    if not message.get('more_body'):
                        try:
                            payload=json.loads(body)
                            tool=payload.get('tool',payload.get('name','unknown'))
                            action=payload.get('args',{}).get('action','')
                            ctx['kind']='tool:'+str(tool)+((':'+action) if action else '')
                        except (ValueError,AttributeError): pass
                return message
            async def sent(message):
                if message['type']=='http.response.start': status[0]=message['status']
                await send(message)
            try: return await app(scope, received, sent)
            finally:
                self.event(dict(type='request',request=ctx,start=start,end=time.time(),status=status[0]))
                CTX.reset(token)
        return wrapped

    def install_sql(self):
        import psycopg
        original=psycopg.Cursor.execute
        def execute(cursor, query, *args, **kwargs):
            if not self.enabled: return original(cursor,query,*args,**kwargs)
            conn=cursor.connection
            pid=conn.info.backend_pid
            text=str(query)
            values=args[0] if args else kwargs.get('params')
            values=values if isinstance(values,(tuple,list)) else ()
            sizes=[len(v) if isinstance(v,(str,bytes)) else None for v in values]
            section=None
            upper=text.upper()
            if 'UPDATE DOC SET VAL' in upper and len(values)>1:
                section=values[1]
            elif ('FROM LOG_D' in upper or 'FROM LOG_L' in upper) and 'SECT=' in upper and values:
                section=values[0]
            if not isinstance(section,str) or len(section)>64: section=None
            start=time.time(); cpu=time.thread_time(); state=None
            try: return original(cursor,query,*args,**kwargs)
            except BaseException as exc:
                state=getattr(exc,'sqlstate',type(exc).__name__)
                raise
            finally:
                end=time.time()
                # Every SQL boundary is retained so per-PID transaction spans
                # and save/load sequences can be reconstructed without values.
                self.event(dict(type='sql',start=start,end=end,cpu_s=time.thread_time()-cpu,
                    pid=pid,native_id=threading.get_native_id(),request=CTX.get(),
                    sql=' '.join(text.split())[:700], asks='section:asks' in text,
                    lock='pg_advisory_xact_lock' in text,state=state,section=section,parameter_chars=sizes))
        psycopg.Cursor.execute=execute


def install(app, api_app, root):
    meter=Meter(root)
    return meter.install(app,api_app)
