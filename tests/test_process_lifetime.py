"""Real Windows process-tree ownership, with no API/provider or live data."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[1]


def alive(pid):
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return False
        except OSError:
            return False
        # A SIGKILLed process becomes a zombie until its parent reaps it via wait()/waitpid();
        # tests poll aliveness before their own tearDown() reaps children, so os.kill(pid, 0)
        # alone cannot tell "still running" from "exited, not yet reaped" here.
        try:
            stat = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
        except Exception:
            stat = ''
        return not stat.startswith('Z')
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
    k.OpenProcess.restype = ctypes.c_void_p
    k.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = k.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    code = ctypes.c_ulong()
    try:
        return bool(k.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        k.CloseHandle(handle)


def eventually(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.04)
    raise AssertionError('process condition did not become true')


class LifetimeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='orgtree-lifetime-')).resolve()
        assert not self.root.is_relative_to((Path.home() / 'orgtree').resolve())
        self.data = self.root / 'data'
        self.data.mkdir()
        self.processes = []
        self.pids = []
        self.worker = self.root / 'worker.py'
        self.worker.write_text("""import json,os,sys,subprocess,time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
root=Path(sys.argv[2]).resolve()
assert Path(os.environ['ORGTREE_DATA']).resolve()==root
from engine.process_lifetime import arm_process_lifetime
spawn=subprocess.Popen
def checked_spawn(*args,**kwargs):
    assert os.environ['ORGTREE_V2_TOKEN']=='must-not-reach-guardian'
    assert 'ORGTREE_V2_TOKEN' not in kwargs['env']
    assert Path(kwargs['env']['ORGTREE_DATA']).resolve()==root
    return spawn(*args,**kwargs)
subprocess.Popen=checked_spawn
if os.name != 'nt':
    os.setpgid(0, 0)
guard=arm_process_lifetime(root,int(sys.argv[3]))
subprocess.Popen=spawn
leaf=root/('leaf-'+str(os.getpid())+'.json')
code='import subprocess,sys,time,json;from pathlib import Path;p=subprocess.Popen([sys.executable,\"-c\",\"import time;time.sleep(90)\"]);Path(sys.argv[1]).write_text(json.dumps(p.pid));time.sleep(90)'
child=subprocess.Popen([sys.executable,'-c',code,str(leaf)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for _ in range(200):
    if leaf.exists():break
    time.sleep(.01)
grandchild=json.loads(leaf.read_text())
escaped=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=(os.name!='nt'))
print(json.dumps({'engine':os.getpid(),'guard':guard,'child':child.pid,'grandchild':grandchild,'escaped_grandchild':escaped.pid}),flush=True)
sys.stdin.readline()
""", encoding='utf-8')

    def start(self, parent=None):
        env = {**os.environ, 'ORGTREE_DATA': str(self.data), 'ORGTREE_V2_TOKEN': 'must-not-reach-guardian'}
        p = subprocess.Popen([sys.executable,str(self.worker),str(REPO),str(self.data),str(parent or os.getpid())],
                             stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,
                             text=True,creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.processes.append(p)
        line = p.stdout.readline()
        if not line:
            raise AssertionError(p.stderr.read())
        ids = json.loads(line)
        self.pids.extend(ids.values())
        for pid in ids.values():
            self.assertTrue(alive(pid), 'positive control: owned process exists')
        return p,ids

    def assert_stopped(self, ids, exclude=()):
        checked = {k: v for k, v in ids.items() if k not in exclude}
        eventually(lambda: all(not alive(pid) for pid in checked.values()))

    def tearDown(self):
        for p in self.processes:
            if p.poll() is None:
                p.kill()
            p.wait(timeout=8)
        for pid in self.pids:
            if alive(pid):
                os.kill(pid, signal.SIGTERM)
        for p in self.processes:
            for pipe in (p.stdin,p.stdout,p.stderr):
                if pipe: pipe.close()

    def test_normal_exit_releases_tree_then_root(self):
        p,ids=self.start()
        env={**os.environ,'ORGTREE_DATA':str(self.data),'ORGTREE_V2_TOKEN':'must-not-reach-guardian'}
        duplicate=subprocess.run([sys.executable,str(self.worker),str(REPO),str(self.data),str(os.getpid())],
                                 env=env,input='',capture_output=True,text=True,timeout=20,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.assertNotEqual(duplicate.returncode,0)
        self.assertIn('another engine owns this data root', duplicate.stderr)
        self.assertTrue(alive(ids['engine']), 'rejected duplicate never kills first engine')
        p.communicate('\n',timeout=8)
        self.assertEqual(p.returncode,0)
        # escaped_grandchild excluded: once engine exits before the guardian's sweep runs, the
        # kernel has already reparented it away (ppid no longer points at engine_pid) with no
        # remaining link back to engine in a `ps` snapshot (unlike child/grandchild, which stay
        # in engine's own process group and so remain discoverable via the pgid-seed check).
        # Sweeping it is only proven where the sweep runs while engine is still alive - see
        # test_desktop_parent_exit_kills_owned_tree and
        # test_teardown_sweeps_grandchild_in_escaped_process_group.
        self.assert_stopped(ids, exclude=('escaped_grandchild',))
        newer,new_ids=self.start()
        newer.communicate('\n',timeout=8)
        self.assert_stopped(new_ids, exclude=('escaped_grandchild',))

    def test_engine_crash_cleans_child(self):
        p,ids=self.start()
        p.kill();p.wait(timeout=8)
        # escaped_grandchild excluded: engine dies (SIGKILL) before the guardian's sweep runs,
        # so it is already reparented away by the time terminate() enumerates - see the comment
        # in test_normal_exit_releases_tree_then_root.
        self.assert_stopped(ids, exclude=('escaped_grandchild',))

    def test_guardian_crash_kills_owned_engine_and_child(self):
        p,ids=self.start()
        os.kill(ids['guard'],signal.SIGTERM)
        self.assert_stopped(ids)
        p.wait(timeout=8)

    def test_desktop_parent_exit_kills_owned_tree(self):
        parent=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'],creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.processes.append(parent)
        p,ids=self.start(parent.pid)
        self.assertTrue(alive(parent.pid))
        parent.kill();parent.wait(timeout=8)
        self.assert_stopped(ids)
        p.wait(timeout=8)

    def test_teardown_spares_unrelated_process_in_inherited_group(self):
        bystander = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(90)'])
        self.processes.append(bystander)
        self.assertTrue(alive(bystander.pid), 'positive control: bystander alive before teardown')
        p, ids = self.start()
        p.communicate('\n', timeout=8)
        self.assertEqual(p.returncode, 0)
        # escaped_grandchild excluded: see the comment in test_normal_exit_releases_tree_then_root.
        self.assert_stopped(ids, exclude=('escaped_grandchild',))
        self.assertTrue(alive(bystander.pid), 'guardian sweep must not reach a process outside its own group')

    def test_teardown_sweeps_grandchild_in_escaped_process_group(self):
        # Trigger teardown via parent death (not engine exit): the engine is still alive when
        # the guardian's sweep enumerates descendants, so the escaped-group grandchild's ppid
        # still points at the engine and is discoverable via the ppid walk. Matches the shape
        # of test_desktop_parent_exit_kills_owned_tree per RESEARCH.md Pitfall 2's warning signs.
        parent = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(90)'],
                                  creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.processes.append(parent)
        p, ids = self.start(parent.pid)
        self.assertIn('escaped_grandchild', ids)
        parent.kill(); parent.wait(timeout=8)
        self.assert_stopped(ids)
        self.assertFalse(alive(ids['escaped_grandchild']),
                         'sweep must reach a descendant in its own escaped process group')
        p.wait(timeout=8)

    def arm_fixture(self, change=None):
        """Fresh private module per probe: injected delays occur in the helper."""
        fixture = self.root / ('fixture-' + str(len(self.processes)))
        fixture.mkdir()
        module = fixture / 'guardian.py'
        source = (REPO / 'engine/process_lifetime.py').read_text(encoding='utf-8')
        if change:
            before, after = change
            self.assertEqual(source.count(before), 1, 'delay injection identifies one real helper phase')
            source = source.replace(before, after)
        module.write_text(source, encoding='utf-8')
        code = """import os,sys,json,time,subprocess
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import guardian
spawn=subprocess.Popen
def record(*args,**kwargs):
    child=spawn(*args,**kwargs)
    Path(sys.argv[1],'helper.pid').write_text(str(child.pid))
    return child
subprocess.Popen=record
if os.name != 'nt':
    os.setpgid(0, 0)
try:
    pid=guardian.arm_process_lifetime(Path(os.environ['ORGTREE_DATA']),os.getppid(),timeout=.2)
except RuntimeError as error:
    print(json.dumps({'handled':True,'alive':os.getpid(),'error':str(error)}),flush=True)
    time.sleep(.6)
    sys.exit(3)
print(json.dumps({'armed':pid}),flush=True)
"""
        env = {**os.environ, 'ORGTREE_DATA': str(self.data)}
        p = subprocess.Popen([sys.executable, '-c', code, str(fixture)], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.processes.append(p)
        out, err = p.communicate(timeout=8)
        helper = int((fixture / 'helper.pid').read_text())
        self.pids.append(helper)
        eventually(lambda: not alive(helper))
        return p.returncode, out, err

    def test_startup_timeout_is_handled_before_and_after_assignment(self):
        code, out, _ = self.arm_fixture()
        self.assertEqual(code, 0)
        self.assertIn('armed', json.loads(out), 'positive control: same worker successfully arms')
        prepared = '        print(json.dumps({"prepared": True, "guardian": os.getpid()}), flush=True)'
        ready = '        print(json.dumps({"ready": True, "guardian": os.getpid()}), flush=True)'
        for marker in (prepared, ready):
            with self.subTest(phase=marker):
                code, out, err = self.arm_fixture((marker, '        time.sleep(.5)\n' + marker))
                self.assertEqual(code, 3, err)
                self.assertTrue(json.loads(out)['handled'], 'engine survives to handle timeout and exit nonzero')
                self.assertIn('preparation' if marker == prepared else 'assignment acknowledgment', json.loads(out)['error'])

    def test_armed_helper_failure_is_nonzero_and_stdout_noise_is_ignored(self):
        marker = '        print(json.dumps({"ready": True, "guardian": os.getpid()}), flush=True)'
        code, out, _ = self.arm_fixture((marker, '        raise RuntimeError("after assignment")\n' + marker))
        if os.name == 'nt':
            self.assertEqual(code, 70, 'armed guardian failure cannot look like a clean engine exit')
        else:
            # POSIX has no equivalent of TerminateJobObject's caller-assigned exit code: the
            # guardian's sweep can only SIGKILL, which the OS reports as a negative signal-number
            # return code. Assert the engine was force-killed by the guardian rather than allowed
            # to complete its own graceful `except RuntimeError: sys.exit(3)` path.
            self.assertEqual(code, -signal.SIGKILL, 'armed guardian failure cannot look like a clean engine exit')
        prepared = '        print(json.dumps({"prepared": True, "guardian": os.getpid()}), flush=True)'
        code, out, err = self.arm_fixture((prepared, '        print("unrelated diagnostic", flush=True)\n' + prepared))
        self.assertEqual(code, 0, err)
        self.assertIn('armed', json.loads(out))


if __name__=='__main__': unittest.main()
