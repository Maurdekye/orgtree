import ctypes as c
from ctypes import wintypes as w
import sys,json
class GUID(c.Structure):
    _fields_=[('data',c.c_ubyte*16)]
    def __init__(self,s):
        import uuid
        super().__init__((c.c_ubyte*16).from_buffer_copy(uuid.UUID(s).bytes_le))
class KEY(c.Structure):_fields_=[('guid',GUID),('pid',w.DWORD)]
class PV(c.Structure):_fields_=[('vt',c.c_ushort),('pad',c.c_ushort*3),('value',c.c_void_p),('extra',c.c_void_p)]
def properties(hwnd):
    ole=c.OleDLL('ole32');ole.CoInitialize(None)
    shell=c.OleDLL('shell32');p=c.c_void_p()
    shell.SHGetPropertyStoreForWindow.argtypes=[w.HWND,c.POINTER(GUID),c.POINTER(c.c_void_p)]
    shell.SHGetPropertyStoreForWindow(hwnd,c.byref(GUID('886d8eeb-8cf2-4446-8d02-cdba1dbdcf99')),c.byref(p))
    vt=c.cast(p,c.POINTER(c.POINTER(c.c_void_p))).contents
    get=c.WINFUNCTYPE(c.c_long,c.c_void_p,c.POINTER(KEY),c.POINTER(PV))(vt[5])
    release=c.WINFUNCTYPE(w.ULONG,c.c_void_p)(vt[2]);out={}
    for pid in [2,3,4,5]:
        val=PV();key=KEY(GUID('9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3'),pid)
        hr=get(p,c.byref(key),c.byref(val));out[str(pid)]=c.wstring_at(val.value) if hr==0 and val.vt==31 and val.value else {'hr':hr,'type':val.vt}
        ole.PropVariantClear(c.byref(val))
    release(p);return out

print(json.dumps(properties(int(sys.argv[1]))))
