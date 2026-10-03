"""The compatibility view (design §6.2 item 3): today's storage layer on an org's own database.

With the storage switch on (``ORGTREE_STORAGE=orgdb``), ``store._Pool.acquire`` hands store.py an
``OrgDbConn`` (``conn``) instead of a connection to the legacy database. store.py keeps issuing
its own SQL against the five legacy tables (doc, nodes, log_d, log_l, meta); ``sql`` recognises
each of those statements by its text and answers it from the org database's tables, through the
section mappers and the exact codec (``rows``). store.py itself is unchanged, so with the switch
off every path is exactly what it was.

A statement store.py issues that ``sql`` does not know raises at once (never a silent wrong
answer); tests/test_orgdb_compat_static.py extracts every statement from store.py's source and
fails when one is neither handled nor listed as unreachable in this mode.

The view is a bridge: the native domain modules replace its readers and writers one domain at
a time, and it is deleted in landing step 8 (design §6.3).

Module map:

  rows   the legacy rows as views over the new tables: doc rows by key, nodes by name, log
         rows by sequence number, meta rows; reads, compare-and-set writes, versions
  sql    the statement registry: store.py's SQL text -> a handler over ``rows``
  conn   ``OrgDbConn``, the connection object store.py sees; transactions, revision + NOTIFY
"""
