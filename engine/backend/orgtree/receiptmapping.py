"""Lazy, CAS-backed receipt dictionaries for a loaded PostgreSQL document.

Deferred reads refuse a changed committed org revision. Exposing a receipt keeps
its exact stored bytes as the write baseline, so nested edits are not missed.
No connection or callable survives in these objects.
"""
from __future__ import annotations

import copy
from typing import Any
from collections.abc import MutableMapping, Mapping
from . import receiptrows


class StaleReceipts(RuntimeError):
    pass


def _read(slug: str, revision: int, query: str, params: tuple[Any, ...]) -> list[Any]:
    from . import store
    with store._POOL.acquire(slug) as conn:
        # A pinned multi-org transaction shares one raw connection. Select this
        # org before bypassing the adapter for the native PostgreSQL query.
        conn.use()
        pinned = conn.pinned
        if not pinned:
            conn.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try:
            current = conn.raw.execute('SELECT revision FROM public.orgs WHERE org_id=%s',
                                       (conn.org_id,)).fetchone()
            if current is None or current[0] != revision:
                raise StaleReceipts('receipt view changed before deferred read')
            return conn.raw.execute(query, params).fetchall()
        finally:
            if not pinned:
                conn.raw.execute('ROLLBACK')


class _LazyMapping(MutableMapping):
    """All generic walks materialize; keyed reads remain selective."""
    def __init__(self):
        self._data = {}

    def plain(self):
        self.materialize()
        return {key: value.plain() if isinstance(value,_LazyMapping) else copy.deepcopy(value)
                for key,value in self._data.items()}

    def materialize(self) -> None:
        raise NotImplementedError

    def get(self, key, default=None):
        try: return self[key]
        except KeyError: return default

    def setdefault(self, key, default=None):
        try: return self[key]
        except KeyError:
            self[key] = default
            return self._data[key]

    def pop(self,key,*default):
        try: value=self[key]
        except KeyError:
            if default: return default[0]
            raise
        del self[key]
        return value

    def __iter__(self): self.materialize(); return iter(self._data)
    def keys(self): self.materialize(); return self._data.keys()
    def items(self): self.materialize(); return self._data.items()
    def values(self): self.materialize(); return self._data.values()
    def copy(self): self.materialize(); return self._data.copy()
    def __repr__(self): self.materialize(); return repr(self._data)
    def __eq__(self, other):
        self.materialize()
        if isinstance(other,_LazyMapping): other.materialize()
        return self._data == (other._data if isinstance(other,_LazyMapping) else other)
    def __ne__(self, other): return not self == other
    def update(self,*args,**kwargs):
        for key,value in dict(*args,**kwargs).items(): self[key]=value
    def __ior__(self,other): self.update(other); return self
    def clear(self):
        for key in list(self.keys()): del self[key]
    def popitem(self):
        self.materialize()
        if not len(self._data): raise KeyError('popitem(): dictionary is empty')
        key=next(reversed(self._data.keys())); value=self._data[key]; del self[key]
        return key,value
    def __deepcopy__(self,memo):
        self.materialize()
        out=self.__class__.__new__(self.__class__); memo[id(self)]=out
        out.__dict__.update(copy.deepcopy(self.__dict__,memo))
        return out


class ReceiptOwner(_LazyMapping):
    def __init__(self,slug: str,revision: int,owner: str,count: int,version: int):
        super().__init__(); self.slug=slug; self.revision=revision; self.owner=owner
        self.count=count; self.version=version; self.complete=False
        self.baselines: dict[str,str|None]={}; self.deleted:set[str]=set()
        self.reinserted:set[str]=set()

    def __getitem__(self,key):
        if (key in self._data): return self._data[key]
        if key in self.deleted or key in self.baselines or self.complete: raise KeyError(key)
        rows=_read(self.slug,self.revision,'SELECT val FROM receipts WHERE owner=%s AND token=%s',(self.owner,key))
        self.baselines[key]=rows[0][0] if rows else None
        if not rows: raise KeyError(key)
        value=receiptrows.validate_receipt(self.owner,key,receiptrows.loads(rows[0][0]))
        self._data.__setitem__(key,value); return value

    def __contains__(self,key):
        try: self[key]; return True
        except KeyError: return False

    def __len__(self):
        return self.count + sum(1 for key in self._data.keys() if self.baselines.get(key) is None) - len(self.deleted)
    def __bool__(self): return len(self)>0

    def __setitem__(self,key,value):
        if key not in self.baselines:
            self.get(key)
        # Preserve nested mutable edits for validation at save, not merely here.
        receiptrows.validate_receipt(self.owner,key,value)
        if key in self.deleted: self.reinserted.add(key)
        self.deleted.discard(key); self._data.__setitem__(key,value)

    def __delitem__(self,key):
        self[key]
        self._data.pop(key); self.reinserted.discard(key)
        if self.baselines.get(key) is not None: self.deleted.add(key)
        else: self.baselines.pop(key,None)

    def materialize(self):
        if self.complete: return
        rows=_read(self.slug,self.revision,'SELECT token,val FROM receipts WHERE owner=%s ORDER BY ord',(self.owner,))
        if len(rows)!=self.count: raise StaleReceipts('receipt owner count mismatch')
        order=[]
        for key,text in rows:
            if key not in self.reinserted: order.append(key)
            if key not in self.baselines: self.baselines[key]=text
            elif self.baselines[key]!=text: raise StaleReceipts('receipt baseline changed')
            if key not in self.deleted and not (key in self._data):
                self._data.__setitem__(key,receiptrows.validate_receipt(self.owner,key,receiptrows.loads(text)))
        known=set(order)
        order += [key for key in self._data.keys() if key not in known]
        values={key:self._data[key] for key in order if (key in self._data)}
        self._data.clear()
        for key,value in values.items(): self._data.__setitem__(key,value)
        self.complete=True

    def changed(self):
        # Only exposed/new rows can have been changed; preserve their exact CAS.
        changes=[]
        for key,value in self._data.items():
            receiptrows.validate_receipt(self.owner,key,value)
            text=receiptrows.dumps(value); old=self.baselines.get(key)
            if text!=old or key in self.reinserted: changes.append((key,text,old))
        return changes


class ReceiptSection(_LazyMapping):
    def __init__(self,slug: str,revision: int):
        super().__init__(); self.slug=slug; self.revision=revision; self.complete=False
        self.missing:set[str]=set(); self.deleted:set[str]=set(); self.replaced:set[str]=set()
        self.reinserted:set[str]=set()
        self.versions:dict[str,int|None]={}

    def __getitem__(self,owner):
        if (owner in self._data): return self._data[owner]
        if owner in self.missing or owner in self.deleted or self.complete: raise KeyError(owner)
        rows=_read(self.slug,self.revision,'SELECT nrows,version FROM receipt_owners WHERE owner=%s',(owner,))
        if not rows:
            self.missing.add(owner); self.versions[owner]=None; raise KeyError(owner)
        count,version=rows[0]; self.versions[owner]=version
        value=ReceiptOwner(self.slug,self.revision,owner,count,version)
        self._data.__setitem__(owner,value); return value

    def __contains__(self,owner):
        try: self[owner]; return True
        except KeyError: return False

    def __len__(self): self.materialize(); return len(self._data)
    def __bool__(self):
        if len(self._data): return True
        if self.complete: return False
        if self.deleted:
            self.materialize(); return len(self._data)>0
        return bool(_read(self.slug,self.revision,'SELECT 1 FROM receipt_owners LIMIT 1',()))

    def __setitem__(self,owner,value):
        if not isinstance(value,Mapping): raise receiptrows.Unsupported('receipt owner must contain a mapping')
        if owner not in self.versions: self.get(owner)
        if owner in self.deleted: self.reinserted.add(owner)
        self.deleted.discard(owner); self.missing.discard(owner); self.replaced.add(owner)
        self._data.__setitem__(owner,value)

    def __delitem__(self,owner):
        self[owner]; self._data.pop(owner); self.replaced.discard(owner); self.reinserted.discard(owner)
        if self.versions.get(owner) is not None: self.deleted.add(owner)
        else: self.missing.add(owner)

    def materialize(self):
        if self.complete:
            for value in self._data.values():
                if isinstance(value,ReceiptOwner): value.materialize()
            return
        rows=_read(self.slug,self.revision,'SELECT owner,nrows,version FROM receipt_owners ORDER BY ord',())
        order=[]
        for owner,count,version in rows:
            if owner not in self.reinserted: order.append(owner)
            if owner in self.versions and self.versions[owner]!=version:
                raise StaleReceipts('receipt owner version changed')
            self.versions[owner]=version
            if owner not in self.deleted and not (owner in self._data):
                self._data.__setitem__(owner,ReceiptOwner(self.slug,self.revision,owner,count,version))
        known=set(order)
        order += [owner for owner in self._data.keys() if owner not in known]
        values={owner:self._data[owner] for owner in order if (owner in self._data)}
        self._data.clear()
        for owner,value in values.items():
            if isinstance(value,ReceiptOwner): value.materialize()
            self._data.__setitem__(owner,value)
        self.complete=True
