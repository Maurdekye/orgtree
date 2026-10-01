"""Lazy, CAS-backed receipt dictionaries for a loaded PostgreSQL document.

Snapshot views (loaded outside an org_tx) refuse deferred reads after the
committed org revision changes. Views loaded inside an org_tx are bound to that
transaction's pinned connection instead (see TxBinding) and refuse after it
ends. Exposing a receipt keeps its exact stored bytes as the write baseline, so
nested edits are not missed. Only a TxBinding reference survives in these
objects; it grants no read once its transaction is over.
"""
from __future__ import annotations

import copy
from typing import Any
from collections.abc import MutableMapping, Mapping
from . import receiptrows


class StaleReceipts(RuntimeError):
    pass


class TxBinding:
    """The pinned org_tx connections a view was loaded inside.

    Disjoint org_tx writers commit concurrently and advance the org revision,
    so a view loaded inside a locked transaction is kept coherent by that
    transaction's locks and owner versions, not by the revision. Such a view
    reads only on the same pinned connection and refuses after it ends.
    """
    def __init__(self, pinned: dict[str, Any]):
        self.pinned = pinned

    def conn(self, slug: str) -> Any:
        from . import store
        if getattr(store._orgtx_local, 'pinned', None) is not self.pinned \
                or slug not in self.pinned:
            raise StaleReceipts('receipt transaction view used after its transaction')
        return self.pinned[slug]

    def __deepcopy__(self, memo): return self
    def __copy__(self): return self


def binding(slug: str) -> TxBinding | None:
    """The current org_tx binding for ``slug``, or None outside one."""
    from . import store
    pinned = getattr(store._orgtx_local, 'pinned', None)
    return TxBinding(pinned) if pinned is not None and slug in pinned else None


def _read(slug: str, revision: int | None, query: str, params: tuple[Any, ...],
          bound: TxBinding | None = None,
          owner_version: tuple[str, int] | None = None) -> list[Any]:
    """One read in its own REPEATABLE READ snapshot (or the bound org_tx).

    The snapshot must still match the view: the owner's version when
    `owner_version` is given, else the org revision when `revision` is not
    None. With neither, the result is a candidate list the caller re-checks."""
    from . import store
    if bound is not None:
        conn = bound.conn(slug)
        conn.use()
        return conn.raw.execute(query, params).fetchall()
    with store._POOL.acquire(slug) as conn:
        # A pinned multi-org transaction shares one raw connection. Select this
        # org before bypassing the adapter for the native PostgreSQL query.
        conn.use()
        pinned = conn.pinned
        if not pinned:
            conn.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try:
            if owner_version is not None:
                current = conn.raw.execute('SELECT version FROM receipt_owners WHERE owner=%s',
                                           (owner_version[0],)).fetchone()
                if current is None or current[0] != owner_version[1]:
                    raise StaleReceipts('receipt owner changed since this view was loaded')
            elif revision is not None:
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
    def __init__(self,slug: str,revision: int,owner: str,count: int,version: int,
                 bound: TxBinding | None = None, versioned: bool = False):
        super().__init__(); self.slug=slug; self.revision=revision; self.owner=owner
        self.bound=bound; self.versioned=versioned
        self.count=count; self.version=version; self.complete=False
        self.baselines: dict[str,str|None]={}; self.deleted:set[str]=set()
        self.reinserted:set[str]=set()

    def __getitem__(self,key):
        if (key in self._data): return self._data[key]
        if key in self.deleted or key in self.baselines or self.complete: raise KeyError(key)
        rows=_read(self.slug,self.revision,'SELECT val FROM receipts WHERE owner=%s AND token=%s',(self.owner,key),self.bound,self._check())
        self.baselines[key]=rows[0][0] if rows else None
        if not rows: raise KeyError(key)
        value=receiptrows.validate_receipt(self.owner,key,receiptrows.loads(rows[0][0]))
        self._data.__setitem__(key,value); return value

    def _check(self):
        return (self.owner,self.version) if self.versioned else None

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
        rows=_read(self.slug,self.revision,'SELECT token,val FROM receipts WHERE owner=%s ORDER BY ord',(self.owner,),self.bound,self._check())
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
    def __init__(self,slug: str,revision: int,bound: TxBinding | None = None,
                 owners: list[tuple[str,int,int]] | None = None):
        super().__init__(); self.slug=slug; self.revision=revision; self.complete=False
        self.bound=bound
        # Owner-version mode: every owner's (nrows, version) read in the load's
        # own snapshot. Reads then check that owner's version, not the org
        # revision, so unrelated commits do not invalidate the view.
        self.snapshot:dict[str,tuple[int,int]]|None=(
            None if owners is None else {o:(int(n),int(v)) for o,n,v in owners})
        self.missing:set[str]=set(); self.deleted:set[str]=set(); self.replaced:set[str]=set()
        self.reinserted:set[str]=set()
        self.versions:dict[str,int|None]={}
        # Keep externally held replacement dictionaries alive across saves.
        self.replacement_baselines:dict[str,str]={}

    @property
    def versioned(self): return self.snapshot is not None

    def __getitem__(self,owner):
        if (owner in self._data): return self._data[owner]
        if owner in self.missing or owner in self.deleted or self.complete: raise KeyError(owner)
        if self.snapshot is not None:
            if owner not in self.snapshot:
                self.missing.add(owner); self.versions[owner]=None; raise KeyError(owner)
            count,version=self.snapshot[owner]; self.versions[owner]=version
            value=ReceiptOwner(self.slug,self.revision,owner,count,version,self.bound,True)
            self._data.__setitem__(owner,value); return value
        rows=_read(self.slug,self.revision,'SELECT nrows,version FROM receipt_owners WHERE owner=%s',(owner,),self.bound)
        if not rows:
            self.missing.add(owner); self.versions[owner]=None; raise KeyError(owner)
        count,version=rows[0]; self.versions[owner]=version
        value=ReceiptOwner(self.slug,self.revision,owner,count,version,self.bound)
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
        if self.snapshot is not None: return bool(self.snapshot)
        return bool(_read(self.slug,self.revision,'SELECT 1 FROM receipt_owners LIMIT 1',(),self.bound))

    def owner_keys(self):
        """Owner names in order, WITHOUT reading any owner's receipts
        (iterating the section materialises every owner's rows)."""
        if self.complete: return list(self._data.keys())
        stored=(list(self.snapshot) if self.snapshot is not None else
                [row[0] for row in _read(self.slug,self.revision,
                 'SELECT owner FROM receipt_owners ORDER BY ord',(),self.bound)])
        known=set(stored)
        return ([o for o in stored if o not in self.deleted and o not in self.reinserted]
                + [o for o in self._data.keys() if o not in known or o in self.reinserted])

    def owners_naming(self,nodes):
        """Owners that may hold a receipt whose `node` is one of `nodes`:
        every stored owner with such a row plus every owner exposed in memory
        (unsaved edits). Answers rename without materialising history."""
        # candidates only: each owner is re-read under its own version check
        stored=[] if self.complete else [row[0] for row in _read(self.slug,
            None if self.snapshot is not None else self.revision,
            "SELECT DISTINCT owner FROM receipts WHERE (val::json->>'node') = ANY(%s) ORDER BY owner",
            (list(nodes),),self.bound)]
        seen=set(); out=[]
        for owner in [*stored,*self._data.keys()]:
            if owner not in seen and owner not in self.deleted:
                seen.add(owner); out.append(owner)
        return out

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
        rows=([(o,n,v) for o,(n,v) in self.snapshot.items()] if self.snapshot is not None else
              _read(self.slug,self.revision,'SELECT owner,nrows,version FROM receipt_owners ORDER BY ord',(),self.bound))
        order=[]
        for owner,count,version in rows:
            if owner not in self.reinserted: order.append(owner)
            if owner in self.versions and self.versions[owner]!=version:
                raise StaleReceipts('receipt owner version changed')
            self.versions[owner]=version
            if owner not in self.deleted and not (owner in self._data):
                self._data.__setitem__(owner,ReceiptOwner(self.slug,self.revision,owner,count,version,
                                                          self.bound,self.snapshot is not None))
        known=set(order)
        order += [owner for owner in self._data.keys() if owner not in known]
        values={owner:self._data[owner] for owner in order if (owner in self._data)}
        self._data.clear()
        for owner,value in values.items():
            if isinstance(value,ReceiptOwner): value.materialize()
            self._data.__setitem__(owner,value)
        self.complete=True
