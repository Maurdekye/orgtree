"""Measurement-only, concurrency-preserving CPU and transaction tracing.

CPU totals are thread_time at worker/callback boundaries. Function costs are a
deterministic sample, never wall time. OS-thread stack weights are estimates.
No product operation, scheduler policy, lock or SQL is changed.
"""
from __future__ import annotations
import asyncio
import collections
import contextvars
import cProfile
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


class Meter:
    def __init__(self, root, every=10):
        self.root = Path(root)
        self.every = every
        self.enabled = False
        self.seq = 0
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
        # Sample first and each Nth operation independently within each class.
        sampled = (self.count[key]-1) % (self.every if where == 'worker' else self.every*5) == 0
        profile = cProfile.Profile(time.thread_time) if sampled else None
        self.local.depth = 1
        start = time.thread_time()
        if profile: profile.enable()
        try:
            return fn(*args, **kwargs)
        finally:
            if profile: profile.disable()
            spent = time.thread_time()-start
            self.cpu[key] += spent
            self.local.depth = 0
            if profile:
                self.sample_cpu[key] += spent
                rows = self.functions.setdefault(key, {})
                for ident, stat in pstats.Stats(profile).stats.items():
                    dest = rows.setdefault(ident, [0, 0, 0.0, 0.0])
                    for i in range(4): dest[i] += stat[i]

    def start(self):
        if self.started: raise RuntimeError('one profile window per engine')
        self.started = dict(wall=time.time(), process=time.process_time())
        self.enabled = True
        threading.Thread(target=self.sampler, name='scale-cpu-sampler', daemon=True).start()
        return self.started

    def finish(self):
        self.finished = dict(wall=time.time(), process=time.process_time())
        self.enabled = False
        self.stop.set()
        data = dict(start=self.started, finish=self.finished, every=self.every,
            count=dict(self.count), cpu=dict(self.cpu), sampled_cpu=dict(self.sample_cpu),
            thread_cpu=dict(self.thread_cpu), thread_names=self.thread_names,
            weighted_stacks=[dict(key=k, cpu_s=v) for k,v in self.stack_cpu.most_common(300)],
            functions={key: [dict(file=i[0], line=i[1], function=i[2], primitive_calls=v[0],
                calls=v[1], self_s=v[2], cumulative_s=v[3]) for i,v in sorted(rows.items(),
                    key=lambda x: x[1][2], reverse=True)[:160]] for key,rows in self.functions.items()},
            event_count=len(self.events), event_cap=150000)
        (self.root/'metrics'/'loaded-cpu.json').write_text(json.dumps(data,indent=2),encoding='utf8')
        with (self.root/'metrics'/'loaded-trace.jsonl').open('w',encoding='utf8') as out:
            for row in self.events: out.write(json.dumps(row)+'\n')
        return dict(events=len(self.events), classes=len(self.cpu), start=self.started, finish=self.finished)

    def sampler(self):
        import psutil
        proc = psutil.Process()
        previous = {t.id:t.user_time+t.system_time for t in proc.threads()}
        while not self.stop.wait(.1):
            frames = sys._current_frames()
            threads = {t.native_id:t for t in threading.enumerate()}
            for t in proc.threads():
                value = t.user_time+t.system_time
                delta = max(0, value-previous.get(t.id,value))
                previous[t.id] = value
                th = threads.get(t.id)
                name = th.name if th else 'unknown-native'
                key = str(t.id)+':'+name
                self.thread_names[str(t.id)] = name
                self.thread_cpu[key] += delta
                frame = frames.get(th.ident) if th else None
                stack = []
                while frame and len(stack)<16:
                    stack.append(f'{os.path.basename(frame.f_code.co_filename)}:{frame.f_code.co_name}:{frame.f_lineno}')
                    frame = frame.f_back
                if delta: self.stack_cpu[key+'|'+';'.join(stack)] += delta

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
            text=str(query)
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
                    pid=conn.info.backend_pid,native_id=threading.get_native_id(),request=CTX.get(),
                    sql=' '.join(text.split())[:700], asks='section:asks' in text,
                    lock='pg_advisory_xact_lock' in text,state=state))
        psycopg.Cursor.execute=execute


def install(app, api_app, root):
    meter=Meter(root)
    return meter.install(app,api_app)
