"""Author the reviewed G1-G11 SQL backfill from mapper field declarations.

This is an authoring tool, never a runtime migration hook. Its full draft
composes the reviewed typed records and current-role links in place. The
eventual migration runs alone in migrate.py's existing transaction. The
independent verifier does not import this tool, its descriptors, or mapper code.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from assert_repo_import import assert_repo_import

PROVENANCE = assert_repo_import(ROOT)

from orgtree.orgdb import codec  # noqa: E402


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def ident(value):
    return codec.quote(value)


HELPERS = r"""
-- All helpers live only in this session. No new runtime codec is installed.
CREATE FUNCTION pg_temp.sc_get(v json, k text) RETURNS json
LANGUAGE sql IMMUTABLE AS $fn$
 SELECT orgtree.docket_field(v,k)
$fn$;
CREATE FUNCTION pg_temp.sc_put(v json, k text, x json) RETURNS json
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE safe json; marker text; result json;
BEGIN
 SELECT s.value,s.marker INTO safe,marker
 FROM orgtree.docket_safe(json_build_array(coalesce(v,'{}'::json),x)) s;
 SELECT json_object_agg(key,value) INTO result FROM (
  SELECT key,value FROM json_each(safe->0) WHERE key<>k
  UNION ALL SELECT k,safe->1) entries;
 RETURN orgtree.docket_restore(result,marker);
END
$fn$;
CREATE FUNCTION pg_temp.sc_drop(v json, keys text[]) RETURNS json
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE safe json; marker text; result json;
BEGIN
 SELECT s.value,s.marker INTO safe,marker FROM orgtree.docket_safe(v) s;
 SELECT coalesce(json_object_agg(key,value),'{}'::json) INTO result
 FROM json_each(safe) WHERE NOT(key=ANY(keys));
 RETURN orgtree.docket_restore(result,marker);
END
$fn$;
CREATE FUNCTION pg_temp.sc_merge(a json,b json) RETURNS json
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE safe json; marker text; result json; entry record;
BEGIN
 SELECT s.value,s.marker INTO safe,marker
 FROM orgtree.docket_safe(json_build_array(coalesce(a,'{}'::json),coalesce(b,'{}'::json))) s;
 result:=safe->0;
 FOR entry IN SELECT * FROM json_each(safe->1) LOOP
  result:=pg_temp.sc_put(result,entry.key,entry.value);
 END LOOP;
 RETURN orgtree.docket_restore(result,marker);
END
$fn$;
CREATE FUNCTION pg_temp.sc_text(v json) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
 IF json_typeof(v)='string' THEN RETURN v#>>'{}'; END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END
$fn$;
CREATE FUNCTION pg_temp.sc_nonnull(v json) RETURNS json
LANGUAGE sql IMMUTABLE AS $fn$
 SELECT CASE WHEN json_typeof(v)='null' THEN NULL ELSE v END
$fn$;
CREATE FUNCTION pg_temp.sc_overlay(a json,b json) RETURNS json
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE safe json; marker text; result json; entry record; old json;
BEGIN
 IF b IS NULL OR json_typeof(b)='null' THEN RETURN a; END IF;
 SELECT s.value,s.marker INTO safe,marker
 FROM orgtree.docket_safe(json_build_array(a,b)) s;
 result:=safe->0;
 FOR entry IN SELECT * FROM json_each(safe->1) LOOP
  old:=result->entry.key;
  IF json_typeof(old)='object' AND json_typeof(entry.value)='object' THEN
   result:=pg_temp.sc_put(result,entry.key,pg_temp.sc_overlay(old,entry.value));
  ELSE result:=pg_temp.sc_put(result,entry.key,entry.value); END IF;
 END LOOP;
 RETURN orgtree.docket_restore(result,marker);
END
$fn$;
CREATE FUNCTION pg_temp.sc_float(v double precision) RETURNS json
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE t text:=v::text;
BEGIN
 IF t !~ '[.eE]' THEN t:=t||'.0'; END IF;
 RETURN t::json;
END
$fn$;
CREATE FUNCTION pg_temp.sc_timestamp(v json) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET timezone='UTC' AS $fn$
DECLARE s text:=pg_temp.sc_text(v); datepart text; rest text; zonepart text;
 datebits text[]; bits text[]; day date; h int; m int; sec int; us int;
 zh int; zm int; zs int; zus int; offset_us bigint; sign int; result timestamp;
BEGIN
 IF s IS NULL OR length(s)<16 THEN RETURN NULL; END IF;
 -- datetime.fromisoformat accepts calendar and ISO-week dates, in either
 -- basic or extended form, followed by one arbitrary separator character.
 datebits:=regexp_match(s,'^(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}-W\d{2}(-[1-7])?|\d{4}W\d{2}[1-7]?)(.)(.*)$');
 IF datebits IS NULL THEN RETURN NULL; END IF;
 datepart:=datebits[1]; rest:=datebits[4];
 IF strpos(datepart,'W')>0 THEN
  bits:=regexp_match(replace(datepart,'-',''),'^(\d{4})W(\d{2})([1-7])?$');
  IF bits[2]::int<1 OR bits[2]::int>53 THEN RETURN NULL; END IF;
  day:=to_date(bits[1]||'-'||bits[2]||'-1','IYYY-IW-ID')+coalesce(bits[3]::int,1)-1;
  IF to_char(day,'IYYYIW')<>bits[1]||bits[2] THEN RETURN NULL; END IF;
 ELSE
  bits:=regexp_match(replace(datepart,'-',''),'^(\d{4})(\d{2})(\d{2})$');
  day:=make_date(bits[1]::int,bits[2]::int,bits[3]::int);
 END IF;
 bits:=regexp_match(rest,'^(.*?)([Zz]|[+-].*)$');
 IF bits IS NULL THEN RETURN NULL; END IF;
 rest:=bits[1]; zonepart:=bits[2];
 IF strpos(rest,':')>0 THEN
  bits:=regexp_match(rest,'^(\d{2}):(\d{2})(:(\d{2}))?([.,](\d+))?$');
  IF bits IS NULL THEN RETURN NULL; END IF;
  h:=bits[1]::int; m:=bits[2]::int; sec:=coalesce(bits[4]::int,0);
  us:=rpad(substr(coalesce(bits[6],''),1,6),6,'0')::int;
 ELSE
  bits:=regexp_match(rest,'^(\d{2})(\d{2})?(\d{2})?([.,](\d+))?$');
  IF bits IS NULL THEN RETURN NULL; END IF;
  h:=bits[1]::int; m:=coalesce(bits[2]::int,0); sec:=coalesce(bits[3]::int,0);
  us:=rpad(substr(coalesce(bits[5],''),1,6),6,'0')::int;
 END IF;
 IF h>23 OR m>59 OR sec>59 THEN RETURN NULL; END IF;
 offset_us:=0;
 IF zonepart NOT IN ('Z','z') THEN
  sign:=CASE substr(zonepart,1,1) WHEN '-' THEN -1 ELSE 1 END;
  zonepart:=substr(zonepart,2);
  IF strpos(zonepart,':')>0 THEN
   bits:=regexp_match(zonepart,'^(\d{2}):(\d{2})(:(\d{2}))?([.,](\d+))?$');
   IF bits IS NULL THEN RETURN NULL; END IF;
   zh:=bits[1]::int; zm:=bits[2]::int; zs:=coalesce(bits[4]::int,0);
   zus:=rpad(substr(coalesce(bits[6],''),1,6),6,'0')::int;
  ELSE
   bits:=regexp_match(zonepart,'^(\d{2})(\d{2})?(\d{2})?([.,](\d+))?$');
   IF bits IS NULL THEN RETURN NULL; END IF;
   zh:=bits[1]::int; zm:=coalesce(bits[2]::int,0); zs:=coalesce(bits[3]::int,0);
   zus:=rpad(substr(coalesce(bits[5],''),1,6),6,'0')::int;
  END IF;
  offset_us:=sign*((zh::bigint*3600+zm*60+zs)*1000000+zus);
  IF abs(offset_us)>=86400000000 THEN RETURN NULL; END IF;
 END IF;
 result:=day::timestamp+make_interval(hours=>h,mins=>m,secs=>sec)
         +us*interval '1 microsecond'-offset_us*interval '1 microsecond';
 RETURN result AT TIME ZONE 'UTC';
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END
$fn$;
CREATE FUNCTION pg_temp.sc_fits(kind text,v json) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE t text:=json_typeof(v); number numeric; d double precision;
BEGIN
 IF v IS NULL OR t='null' THEN RETURN false; END IF;
 CASE kind
 WHEN 'text' THEN RETURN pg_temp.sc_text(v) IS NOT NULL;
 WHEN 'bool' THEN RETURN t='boolean';
 WHEN 'json' THEN RETURN true;
 WHEN 'ts' THEN RETURN pg_temp.sc_timestamp(v) IS NOT NULL;
 WHEN 'int' THEN
  IF t<>'number' OR v::text !~ '^-?[0-9]+$' THEN RETURN false; END IF;
  number:=v::text::numeric;
  RETURN number BETWEEN -9223372036854775808 AND 9223372036854775807;
 WHEN 'float' THEN
  IF t<>'number' OR v::text !~ '[.eE]' THEN RETURN false; END IF;
  d:=v::text::double precision;
  RETURN d NOT IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision);
 WHEN 'num' THEN
  IF t<>'number' THEN RETURN false; END IF;
  number:=v::text::numeric;
  IF v::text ~ '[.eE]' THEN
   d:=v::text::double precision;
   IF d IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN RETURN false; END IF;
  END IF;
  RETURN NOT(number=0 AND v::text ~ '^-' AND v::text ~ '[.eE]');
 ELSE RAISE EXCEPTION 'unknown migration scalar %',kind;
 END CASE;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN false;
END
$fn$;
CREATE FUNCTION pg_temp.sc_number(v json) RETURNS json
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE t text:=v::text::numeric::text;
BEGIN
 IF v::text ~ '[.eE]' AND t !~ '[.eE]' THEN t:=t||'.0'; END IF;
 RETURN t::json;
END
$fn$;
CREATE FUNCTION pg_temp.sc_ts_json(v json) RETURNS json
LANGUAGE sql IMMUTABLE SET timezone='UTC' AS $fn$
 SELECT to_json(to_char(pg_temp.sc_timestamp(v),'YYYY-MM-DD"T"HH24:MI:SS.')||
 lpad((extract(microseconds FROM pg_temp.sc_timestamp(v))::bigint%1000000/1000)::text,3,'0')||'Z')
$fn$;
CREATE FUNCTION pg_temp.sc_string(v json) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE safe json; marker text; s text; result text:=''; i int:=1; code int; low int;
BEGIN
 SELECT x.value,x.marker INTO safe,marker FROM orgtree.docket_safe(v) x;
 s:=safe#>>'{}';
 WHILE i<=length(s) LOOP
  IF substr(s,i,length(marker))=marker THEN
   code:=('x'||substr(s,i+length(marker)+1,4))::bit(16)::int;
   i:=i+length(marker)+5;
   IF code BETWEEN 55296 AND 56319 AND substr(s,i,length(marker))=marker THEN
    low:=('x'||substr(s,i+length(marker)+1,4))::bit(16)::int;
    IF low BETWEEN 56320 AND 57343 THEN
     code:=65536+(code-55296)*1024+low-56320; i:=i+length(marker)+5;
    END IF;
   END IF;
  ELSE code:=ascii(substr(s,i,1)); i:=i+1; END IF;
  result:=result||lpad(to_hex(code),6,'0');
 END LOOP;
 RETURN result;
END
$fn$;
CREATE FUNCTION pg_temp.sc_canonical(v json) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE t text:=json_typeof(v); safe json; marker text; result text;
BEGIN
 IF v IS NULL THEN RETURN 'missing'; END IF;
 IF t='number' THEN
  IF v::text ~ '[.eE]' THEN RETURN 'float:'||(v::text::double precision)::text; END IF;
  RETURN 'int:'||(v::text::numeric)::text;
 END IF;
 IF t IN ('null','boolean') THEN RETURN t||':'||v::text; END IF;
 SELECT s.value,s.marker INTO safe,marker FROM orgtree.docket_safe(v) s;
 IF t='string' THEN
  RETURN 'string:'||pg_temp.sc_string(v);
 ELSIF t='array' THEN
  SELECT coalesce(string_agg(pg_temp.sc_canonical(orgtree.docket_restore(value,marker)),',' ORDER BY ord),'')
   INTO result FROM json_array_elements(safe) WITH ORDINALITY x(value,ord);
  RETURN 'array:['||result||']';
 ELSIF t='object' THEN
  SELECT coalesce(string_agg(
    pg_temp.sc_string(orgtree.docket_restore(to_json(key),marker))||':'||
    pg_temp.sc_canonical(orgtree.docket_restore(value,marker)),','
    ORDER BY pg_temp.sc_string(orgtree.docket_restore(to_json(key),marker)) COLLATE "C"),'')
   INTO result FROM json_each(safe);
  RETURN 'object:{'||result||'}';
 END IF;
 RAISE EXCEPTION 'unexpected migration JSON type %',t;
END
$fn$;
CREATE FUNCTION pg_temp.sc_assert(a json,b json,label text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
 IF pg_temp.sc_canonical(a) IS DISTINCT FROM pg_temp.sc_canonical(b) THEN
  RAISE EXCEPTION 'schema conformance changed %',label;
 END IF;
END
$fn$;
"""


class Compiler:
    """Compile bounded field specs to session-only encode/decode functions."""

    def __init__(self):
        self.statements = [HELPERS]
        self.counter = 0

    def function(self, spec, prefix=''):
        self.counter += 1
        name = f'sc_record_{self.counter}'
        enc, dec = [], []
        recognized = [f.key for f in spec.fields]
        for field in spec.fields:
            e, d = self.field(field, prefix)
            enc += e
            dec += d
        keys = 'ARRAY[' + ','.join(literal(k) for k in recognized) + ']::text[]'
        self.statements += [f"""
CREATE FUNCTION pg_temp.{name}_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{{}}'; e json; children json:='{{}}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,{keys});
 {chr(10).join(enc)}
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{{}}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.{name}_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{{}}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 {chr(10).join(dec)}
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;
"""]
        return name

    def field(self, f, prefix):
        key, col = literal(f.key), prefix + f.col
        c = literal(col)
        put = lambda column, value: f'r:=pg_temp.sc_put(r,{literal(column)},{value});'
        read = lambda column: f'pg_temp.sc_nonnull(pg_temp.sc_get(r,{literal(column)}))'
        value = f'pg_temp.sc_get(v,{key})'
        enc = [f'x:={value};']
        dec = []
        if f.kind in codec.SCALARS:
            fit = f'pg_temp.sc_fits({literal(f.kind)},x)'
            if f.values:
                fit += ' AND pg_temp.sc_text(x)=ANY(ARRAY[' + ','.join(map(literal, f.values)) + '])'
            stored = xstored = 'x'
            if f.kind == 'num':
                stored = 'pg_temp.sc_number(x)'
            if f.kind == 'ts':
                stored = 'to_json(pg_temp.sc_timestamp(x))'
                xstored = 'coalesce(' + read(col + '_text') + ',pg_temp.sc_ts_json(' + read(col) + '))'
            enc += [f'IF x IS NOT NULL THEN',
                    f" IF json_typeof(x)='null' THEN " +
                    (put(col+'_null', "'true'::json") if f.nullable else f'e:=pg_temp.sc_put(e,{key},x);'),
                    f' ELSIF {fit} THEN {put(col, stored)}',
                    (f" IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN {put(col+'_text','x')} END IF;" if f.kind == 'ts' else ''),
                    f' ELSE e:=pg_temp.sc_put(e,{key},x); END IF; END IF;']
            dec += [f'x:={read(col)};', f"IF x IS NOT NULL AND json_typeof(x)<>'null' THEN",
                    f' v:=pg_temp.sc_put(v,{key},{xstored});']
            if f.kind == 'float':
                dec[-1] = f' v:=pg_temp.sc_put(v,{key},pg_temp.sc_float(x::text::double precision));'
            if f.nullable:
                dec += [f"ELSIF {read(col+'_null')}::text='true' THEN v:=pg_temp.sc_put(v,{key},'null');"]
            dec += ['END IF;']
            return enc, dec
        marker = col + '_is'
        mark = lambda shape: put(marker, literal(json.dumps(shape))+'::json')
        if f.kind == 'principal':
            members = ('node', 'generation', 'born', 'deleted')
            types = ('text', 'int', 'text', 'bool')
            suffixes = ('name', 'generation', 'born', 'deleted')
            aliases = dict(f.principal_aliases)
            fields = tuple(codec.Field(k, t, col=aliases.get(k,col+'_'+s), nullable=True)
                           for k, t, s in zip(members, types, suffixes))
            nested = self.function(codec.Spec('', fields))
            namecol = aliases.get('node', col+'_name')
            enc += ["IF x IS NOT NULL THEN",
                    f" IF json_typeof(x)='null' THEN {mark('n')}",
                    f" ELSIF pg_temp.sc_fits('text',x) THEN {mark('s')} {put(namecol,'x')}",
                    f" ELSIF json_typeof(x)='object' THEN {mark('o')}",
                    f"  sub:=pg_temp.{nested}_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));",
                    f"  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,{key},pg_temp.sc_get(sub,'extra')); END IF;",
                    f" ELSE {mark('x')} e:=pg_temp.sc_put(e,{key},x); END IF;",
                    f' n:=pg_temp.sc_text({read(namecol)});',
                    " IF n IS NOT NULL THEN "+put(col+'_kind', "to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)")+" END IF;",
                    'END IF;']
            dec += [f'shape:=pg_temp.sc_text({read(marker)});',
                    f"IF shape='n' THEN v:=pg_temp.sc_put(v,{key},'null');",
                    f"ELSIF shape='s' THEN v:=pg_temp.sc_put(v,{key},{read(namecol)});",
                    f"ELSIF shape='o' THEN v:=pg_temp.sc_put(v,{key},pg_temp.{nested}_decode(r,pg_temp.sc_get(e,{key}),'{{}}'));",
                    'END IF;']
            return enc, dec
        if f.kind == 'sum':
            enc += ['IF x IS NOT NULL THEN',
                    f" IF json_typeof(x)='null' THEN {mark('n')}",
                    " ELSIF json_typeof(x)='array' THEN",
                    "  IF json_array_length(x)=2 AND pg_temp.sc_text(orgtree.docket_field(x,'0'))='i'",
                    "   AND json_typeof(orgtree.docket_field(x,'1'))='number' AND orgtree.docket_field(x,'1')::text ~ '^-?[0-9]+$' THEN",
                    '   '+mark('l')+put(col+'_kind',literal('"i"')+'::json')+put(col+'_integer', "orgtree.docket_field(x,'1')"),
                    "  ELSIF json_array_length(x)=3 AND pg_temp.sc_text(orgtree.docket_field(x,'0'))='f'",
                    "   AND pg_temp.sc_fits('float',orgtree.docket_field(x,'1')) AND pg_temp.sc_fits('float',orgtree.docket_field(x,'2')) THEN",
                    '   '+mark('l')+put(col+'_kind',literal('"f"')+'::json')+put(col+'_float', "orgtree.docket_field(x,'1')")+put(col+'_compensation', "orgtree.docket_field(x,'2')"),
                    f"  ELSE {mark('x')} e:=pg_temp.sc_put(e,{key},x); END IF;",
                    f" ELSE {mark('x')} e:=pg_temp.sc_put(e,{key},x); END IF; END IF;"]
            dec += [f'shape:=pg_temp.sc_text({read(marker)});',
                    f"IF shape='n' THEN v:=pg_temp.sc_put(v,{key},'null');",
                    f"ELSIF shape='l' THEN IF pg_temp.sc_text({read(col+'_kind')})='i' THEN",
                    f" v:=pg_temp.sc_put(v,{key},json_build_array('i',{read(col+'_integer')}));",
                    f" ELSE v:=pg_temp.sc_put(v,{key},json_build_array('f',pg_temp.sc_float({read(col+'_float')}::text::double precision),pg_temp.sc_float({read(col+'_compensation')}::text::double precision))); END IF; END IF;"]
            return enc, dec
        if f.kind in ('obj', 'turn_usage'):
            subprefix = (col.removesuffix('_key') if f.kind == 'turn_usage' else col) + '_'
            nested = self.function(f.spec, subprefix)
            enc += ['IF x IS NOT NULL THEN',
                    f" IF json_typeof(x)='null' THEN {mark('n')}",
                    f" ELSIF json_typeof(x)='object' THEN {mark('o')}",
                    f"  sub:=pg_temp.{nested}_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));",
                    f"  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,{key},pg_temp.sc_get(sub,'extra')); END IF;",
                    f" ELSE {mark('x')} e:=pg_temp.sc_put(e,{key},x); END IF; END IF;"]
            dec += [f'shape:=pg_temp.sc_text({read(marker)});',
                    f"IF shape='n' THEN v:=pg_temp.sc_put(v,{key},'null');",
                    f"ELSIF shape='o' THEN v:=pg_temp.sc_put(v,{key},pg_temp.{nested}_decode(r,pg_temp.sc_get(e,{key}),children)); END IF;"]
            if f.kind == 'turn_usage':
                # Older releases stored just the keys list, using the same child.
                enc += [f"IF json_typeof({value})='array' THEN",
                        f' sub:=pg_temp.{nested}_encode(json_build_object(\'keys\',{value}));',
                        f" IF pg_temp.sc_text(orgtree.docket_field(sub,'row',{literal(subprefix+'keys_is')}))='l' THEN",
                        f"  {mark('l')} r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children')); e:=pg_temp.sc_drop(e,ARRAY[{key}]); END IF; END IF;"]
                dec += [f"IF shape='l' THEN sub:=pg_temp.{nested}_decode(r,'{{}}',children); v:=pg_temp.sc_put(v,{key},pg_temp.sc_get(sub,'keys')); END IF;"]
            return enc, dec
        if f.kind == 'list':
            if f.spec is not None:
                raise ValueError('record children are migrated by their own tables')
            child = literal(f.child_table)
            enc += ['IF x IS NOT NULL THEN',
                    f" IF json_typeof(x)='null' THEN {mark('n')}",
                    " ELSIF json_typeof(x)='array' AND NOT EXISTS(",
                    "  SELECT 1 FROM json_array_elements((SELECT value FROM orgtree.docket_safe(x))) a(value)",
                    f"  WHERE NOT pg_temp.sc_fits({literal(f.item)},orgtree.docket_restore(a.value,(SELECT marker FROM orgtree.docket_safe(x))))) THEN",
                    f"  {mark('l')} children:=pg_temp.sc_put(children,{child},x);",
                    f" ELSE {mark('x')} e:=pg_temp.sc_put(e,{key},x); END IF; END IF;"]
            dec += [f'shape:=pg_temp.sc_text({read(marker)});',
                    f"IF shape='n' THEN v:=pg_temp.sc_put(v,{key},'null');",
                    f"ELSIF shape='l' THEN v:=pg_temp.sc_put(v,{key},coalesce(pg_temp.sc_get(children,{child}),'[]'::json)); END IF;"]
            return enc, dec
        raise ValueError(f'unhandled migration field {f.kind}')


def subset(spec, keys):
    return codec.Spec(spec.table, tuple(spec.field(k) for k in keys))


def cast_column(pack, column, typ):
    x = f"pg_temp.sc_nonnull(orgtree.docket_field({pack},'row',{literal(column)}))"
    if typ == 'json':
        return x
    if typ in ('text', 'char(1)', 'timestamptz'):
        return f'pg_temp.sc_text({x})::{typ}'
    return f'{x}::text::{typ}'


class Migration:
    """One transactional DDL/backfill, retaining each existing physical row."""

    def __init__(self):
        self.compiler = Compiler()
        self.migrated_tables = []
        self.body = [
            '-- Authored with tools/schema_conformance_sql.py; edit the generator.',
            '-- Alpha databases migrate in place. No legacy reconversion is used.',
            "SET LOCAL timezone='UTC';",
            # Migration admission blocks other writers before any FK/backfill.
            'LOCK TABLE orgtree.agents IN EXCLUSIVE MODE;',
            # DDL after row backfills cannot coexist with pending deferred
            # trigger events. Keep statement delta collectors active, suspend
            # only our flush triggers, and queue them after the final DDL.
            # No foreign key or user-authored trigger is disabled or forced.
            """
CREATE TEMP TABLE sc_flush_triggers ON COMMIT DROP AS
 SELECT t.tgrelid,t.tgname,t.tgenabled,c.relname
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace s ON s.oid=c.relnamespace
 JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
 WHERE s.nspname='orgtree' AND f.nspname='orgtree' AND NOT t.tgisinternal
  AND p.proname IN ('foreground_flush','docket_archive_flush')
  AND c.relname IN ('agents','work_items','work_item_artifacts','work_item_holders','work_item_events');
DO $pause_flush$
DECLARE t record;
BEGIN
 FOR t IN SELECT * FROM sc_flush_triggers ORDER BY tgrelid,tgname LOOP
  EXECUTE format('ALTER TABLE orgtree.%I DISABLE TRIGGER %I',t.relname,t.tgname);
 END LOOP;
END $pause_flush$;
""",
        ]

    def migrate_record(self, table, oldspec, newspec, *, keys=('id',), where='true',
                       prefix='', before='', after='', encode_value='original', restore=''):
        if table not in self.migrated_tables:
            self.migrated_tables.append(table)
        oldfn = self.compiler.function(oldspec, prefix)
        newfn = self.compiler.function(newspec, prefix)
        oldcols, newcols = dict(codec.columns(oldspec, prefix)), dict(codec.columns(newspec, prefix))
        renamed = {}
        for column, typ in newcols.items():
            if column in oldcols and oldcols[column] != typ:
                renamed[column] = 'sc_old_'+column
                self.body.append(f'ALTER TABLE orgtree.{ident(table)} RENAME COLUMN {ident(column)} TO {ident(renamed[column])};')
            if column not in oldcols or column in renamed:
                self.body.append(f'ALTER TABLE orgtree.{ident(table)} ADD COLUMN IF NOT EXISTS {ident(column)} {typ};')
        restore_columns = ''.join(
            f'raw:=pg_temp.sc_put(raw,{literal(c)},pg_temp.sc_get(raw,{literal(old)}));'
            for c, old in renamed.items())
        update = [f'{ident(c)}={cast_column("pack",c,t)}' for c, t in newcols.items()]
        update += ["extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra'))"]
        match = ' AND '.join(f't.{ident(k)}=old.{ident(k)}' for k in keys)
        assignments = ',\n '.join(update)
        decoded = f"pg_temp.{newfn}_decode(changed,pg_temp.sc_get(changed,'extra'),children)"
        restored = restore.replace('{value}', decoded) if restore else decoded
        self.body.append(f"""
DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree.{ident(table)} t WHERE {where}
  ORDER BY {','.join('t.'+ident(k) for k in keys)} LOOP
  raw:=old.raw; {restore_columns}
  original:=pg_temp.{oldfn}_decode(raw,pg_temp.sc_get(raw,'extra'),'{{}}');
  {before}
  pack:=pg_temp.{newfn}_encode({encode_value});
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert({encode_value},pg_temp.{newfn}_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            '{table} before write');
  UPDATE orgtree.{ident(table)} t SET {assignments} WHERE {match};
  {after}
  SELECT to_json(t) INTO changed FROM orgtree.{ident(table)} t WHERE {match};
  PERFORM pg_temp.sc_assert(original,{restored},
                            '{table} after write');
 END LOOP;
END
$backfill$;
""")
        for column in sorted(oldcols.keys() - newcols.keys()):
            self.body.append(f'ALTER TABLE orgtree.{ident(table)} DROP COLUMN {ident(column)};')
        for column in renamed.values():
            self.body.append(f'ALTER TABLE orgtree.{ident(table)} DROP COLUMN {ident(column)};')
        constraints = [(col, vals) for col, _, vals in
                       (*codec.enumerated(newspec, prefix), *codec.markers(newspec, prefix))]
        constraints.extend(codec.tagged(newspec, prefix))
        for column, values in constraints:
            if column not in oldcols:
                self.body.append(f'ALTER TABLE orgtree.{ident(table)} ADD CONSTRAINT '
                    f'{ident(table+"_"+column+"_enum")} CHECK({ident(column)} IN ('+
                    ','.join(map(literal, values))+'));')

    def render(self):
        flush_tail = f"""
DO $resume_flush$
DECLARE t record; mode text;
BEGIN
 FOR t IN SELECT * FROM sc_flush_triggers ORDER BY tgrelid,tgname LOOP
  mode:=CASE t.tgenabled WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA'
         WHEN 'A' THEN 'ENABLE ALWAYS' ELSE 'ENABLE' END;
  EXECUTE format('ALTER TABLE orgtree.%I %s TRIGGER %I',t.relname,mode,t.tgname);
 END LOOP;
 -- The same native AFTER ROW triggers perform the commit-time flush. All
 -- earlier statement deltas are still transaction-local, including new
 -- continuity tombstones. No revision lock is acquired during the backfill.
 FOR t IN SELECT DISTINCT relname FROM sc_flush_triggers
           WHERE tgenabled IN ('O','A') AND relname IN ({','.join(map(literal,self.migrated_tables))}) ORDER BY relname LOOP
  EXECUTE format('UPDATE orgtree.%I SET extra=extra WHERE ctid=(SELECT ctid FROM orgtree.%I LIMIT 1)',
                 t.relname,t.relname);
 END LOOP;
END $resume_flush$;
"""
        text = '\n'.join(self.compiler.statements + self.body + [flush_tail])
        return '\n'.join(line.rstrip() for line in text.splitlines()).rstrip() + '\n'


def python_value_helpers():
    """SQL's cold identity comparison follows the existing Python coercions.

    The ranges come from the authoring interpreter, not an installed Python
    migration hook. They cover Python repr/strip and decimal Unicode digits.
    """
    ranges=[]
    start=None
    for code in range(0x110000):
        if not chr(code).isprintable():
            if start is None:
                start=code
        elif start is not None:
            ranges.append((start,code-1)); start=None
    if start is not None:
        ranges.append((start,0x10ffff))
    chars=[]
    for code in range(0x110000):
        value=unicodedata.decimal(chr(code),None)
        if value is not None or chr(code).isspace():
            chars.append((code,'NULL' if value is None else str(value),str(chr(code).isspace()).lower()))
    return '''
CREATE TEMP TABLE sc_python_nonprintable(lo int,hi int) ON COMMIT DROP;
INSERT INTO sc_python_nonprintable VALUES '''+','.join(f'({a},{b})' for a,b in ranges)+''';
CREATE TEMP TABLE sc_python_chars(code int PRIMARY KEY,digit int,space boolean) ON COMMIT DROP;
INSERT INTO sc_python_chars VALUES '''+','.join(f'({a},{b},{c})' for a,b,c in chars)+r''';
CREATE FUNCTION pg_temp.sc_truth(v json) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE t text:=json_typeof(v); safe json;
BEGIN
 IF v IS NULL OR t='null' THEN RETURN false; END IF;
 IF t='boolean' THEN RETURN v::text::boolean; END IF;
 IF t='number' THEN RETURN v::text::numeric<>0; END IF;
 IF t='string' THEN RETURN pg_temp.sc_string(v)<>''; END IF;
 IF t='array' THEN RETURN json_array_length(v)>0; END IF;
 SELECT value INTO safe FROM orgtree.docket_safe(v);
 RETURN EXISTS(SELECT 1 FROM json_each(safe));
END $fn$;
CREATE FUNCTION pg_temp.sc_quote(v json) RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE codes text:=pg_temp.sc_string(v); q text:=chr(39); result text; i int; code int;
BEGIN
 IF EXISTS(SELECT 1 FROM generate_series(0,length(codes)/6-1) x(i)
           WHERE substr(codes,x.i*6+1,6)='000027')
    AND NOT EXISTS(SELECT 1 FROM generate_series(0,length(codes)/6-1) x(i)
                   WHERE substr(codes,x.i*6+1,6)='000022') THEN q:=chr(34); END IF;
 result:=q;
 FOR i IN 0..length(codes)/6-1 LOOP
  code:=('x'||substr(codes,i*6+1,6))::bit(24)::int;
  IF code IN (ascii(q),92) THEN result:=result||chr(92)||chr(code);
  ELSIF code IN (9,10,13) THEN result:=result||chr(92)||CASE code WHEN 9 THEN 't' WHEN 10 THEN 'n' ELSE 'r' END;
  ELSIF EXISTS(SELECT 1 FROM sc_python_nonprintable WHERE code BETWEEN lo AND hi) THEN
   result:=result||chr(92)||CASE WHEN code<256 THEN 'x'||lpad(to_hex(code),2,'0')
    WHEN code<65536 THEN 'u'||lpad(to_hex(code),4,'0') ELSE 'U'||lpad(to_hex(code),8,'0') END;
  ELSE result:=result||chr(code); END IF;
 END LOOP;
 RETURN result||q;
END $fn$;
CREATE FUNCTION pg_temp.sc_repr(v json) RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE t text:=json_typeof(v); safe json; marker text; result text; e record;
BEGIN
 IF v IS NULL OR t='null' THEN RETURN 'None'; END IF;
 IF t='boolean' THEN RETURN CASE WHEN v::text='true' THEN 'True' ELSE 'False' END; END IF;
 IF t='number' THEN RETURN CASE WHEN v::text ~ '[.eE]' THEN v::text ELSE v::text::numeric::text END; END IF;
 IF t='string' THEN RETURN pg_temp.sc_quote(v); END IF;
 SELECT x.value,x.marker INTO safe,marker FROM orgtree.docket_safe(v) x;
 result:='';
 IF t='array' THEN
  FOR e IN SELECT value FROM json_array_elements(safe) LOOP
   result:=result||CASE WHEN result='' THEN '' ELSE ', ' END||pg_temp.sc_repr(orgtree.docket_restore(e.value,marker));
  END LOOP;
  RETURN '['||result||']';
 END IF;
 FOR e IN SELECT * FROM json_each(safe) LOOP
  result:=result||CASE WHEN result='' THEN '' ELSE ', ' END||pg_temp.sc_quote(orgtree.docket_restore(to_json(e.key),marker))
   ||': '||pg_temp.sc_repr(orgtree.docket_restore(e.value,marker));
 END LOOP;
 RETURN '{'||result||'}';
END $fn$;
CREATE FUNCTION pg_temp.sc_python_str(v json) RETURNS text LANGUAGE plpgsql STABLE AS $fn$
BEGIN
 IF NOT pg_temp.sc_truth(v) THEN RETURN ''; END IF;
 IF json_typeof(v)='string' THEN RETURN pg_temp.sc_text(v); END IF;
 RETURN pg_temp.sc_repr(v);
END $fn$;
CREATE FUNCTION pg_temp.sc_python_int(v json) RETURNS numeric LANGUAGE plpgsql STABLE AS $fn$
DECLARE t text:=json_typeof(v); s text; normalized text:=''; i int; digit int;
BEGIN
 IF NOT pg_temp.sc_truth(v) THEN RETURN 0; END IF;
 IF t='boolean' THEN RETURN 1; END IF;
 IF t='number' THEN RETURN trunc(v::text::numeric); END IF;
 IF t<>'string' THEN RETURN NULL; END IF;
 s:=pg_temp.sc_text(v); IF s IS NULL THEN RETURN NULL; END IF;
 WHILE length(s)>0 AND EXISTS(SELECT 1 FROM sc_python_chars WHERE code=ascii(left(s,1)) AND space) LOOP s:=substr(s,2); END LOOP;
 WHILE length(s)>0 AND EXISTS(SELECT 1 FROM sc_python_chars WHERE code=ascii(right(s,1)) AND space) LOOP s:=left(s,length(s)-1); END LOOP;
 FOR i IN 1..length(s) LOOP
  SELECT c.digit INTO digit FROM sc_python_chars c WHERE code=ascii(substr(s,i,1));
  normalized:=normalized||coalesce(digit::text,substr(s,i,1));
 END LOOP;
 IF normalized !~ '^[-+]?[0-9]+(_[0-9]+)*$' THEN RETURN NULL; END IF;
 RETURN replace(normalized,'_','')::numeric;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END $fn$;
'''


def current_reference_sql(migration):
    from orgtree.orgdb.mappers import agents as A
    identity=migration.compiler.function(subset(A.HOT,('seat_id','generation')))
    tomb=migration.compiler.function(subset(A.TOMBSTONE_HOT,('state','seat_id','generation')))
    columns=codec.columns(subset(A.TOMBSTONE_HOT,('state','seat_id','generation')))
    migration.compiler.statements.append(python_value_helpers())
    migration.compiler.statements.append(f'''
CREATE FUNCTION pg_temp.sc_current(v json) RETURNS bigint LANGUAGE plpgsql AS $fn$
DECLARE n text; born text; gen bigint; deleted boolean; x json; row record; identity json; pack json; aid bigint;
BEGIN
 IF json_typeof(v)='string' THEN v:=json_build_object('node',v); END IF;
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 n:=pg_temp.sc_text(pg_temp.sc_get(v,'node'));
 IF n IS NULL OR n='' OR n IN ('user','orgtree') OR n LIKE '@org:%' OR n LIKE '@net:%' THEN RETURN NULL; END IF;
 x:=pg_temp.sc_get(v,'born');
 IF x IS NOT NULL AND json_typeof(x)<>'null' AND NOT pg_temp.sc_fits('text',x) THEN RETURN NULL; END IF;
 born:=coalesce(pg_temp.sc_text(x),'');
 x:=pg_temp.sc_get(v,'generation');
 IF x IS NOT NULL AND json_typeof(x)<>'null' AND NOT pg_temp.sc_fits('int',x) THEN RETURN NULL; END IF;
 gen:=coalesce(pg_temp.sc_nonnull(x)::text::bigint,0);
 x:=pg_temp.sc_get(v,'deleted');
 IF x IS NOT NULL AND json_typeof(x)<>'null' AND NOT pg_temp.sc_fits('bool',x) THEN RETURN NULL; END IF;
 deleted:=coalesce(pg_temp.sc_nonnull(x)::text::boolean,false);
 SELECT t.* INTO row FROM orgtree.agents t WHERE name=n AND NOT tombstone FOR UPDATE;
 IF FOUND AND NOT deleted THEN
  identity:=pg_temp.{identity}_decode(to_json(row),row.extra,'{{}}');
  IF (born<>'' AND born=pg_temp.sc_python_str(pg_temp.sc_get(identity,'seat_id')))
   OR (born='' AND pg_temp.sc_python_int(pg_temp.sc_get(identity,'generation'))>=gen) THEN RETURN row.id; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('orgdb-agent-name'),hashtext(n));
 SELECT id INTO aid FROM orgtree.agents WHERE name=n AND tombstone AND state='deleted'
  AND lineage_born=born AND generation=gen ORDER BY id LIMIT 1;
 IF aid IS NOT NULL THEN RETURN aid; END IF;
 pack:=pg_temp.{tomb}_encode(json_build_object('state','deleted','seat_id',born,'generation',gen));
 INSERT INTO orgtree.agents(name,ord,tombstone,{','.join(ident(c) for c,_ in columns)},extra)
 VALUES(n,NULL,true,{','.join(cast_column('pack',c,t) for c,t in columns)},pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')))
 RETURNING id INTO aid;
 RETURN aid;
END $fn$;
''')
    migration.body.append(A.AGENTS.indexes[-1]+';')


def insert_pack(table, spec, key_values):
    columns=list(codec.columns(spec))
    names=list(key_values)+[c for c,_ in columns]+['extra']
    values=list(key_values.values())+[cast_column('pack',c,t) for c,t in columns]+["pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra'))"]
    return f"INSERT INTO orgtree.{ident(table)}({','.join(map(ident,names))}) VALUES({','.join(values)});"


def docket_backfill(migration):
    from orgtree.orgdb import docket_relations as R
    from orgtree.orgdb.mappers import docket as D
    out=migration.body
    current_reference_sql(migration)
    out += [
        'ALTER TABLE orgtree.work_items ADD COLUMN review_seats_is char(1) CHECK(review_seats_is IN (\'n\',\'l\',\'x\'));',
        'ALTER TABLE orgtree.work_items ADD COLUMN owner_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE;',
        'ALTER TABLE orgtree.work_items ADD COLUMN reviewer_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE;',
        'ALTER TABLE orgtree.work_item_holders ADD COLUMN agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE;',
        'ALTER TABLE orgtree.work_item_artifacts ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;',
        "ALTER TABLE orgtree.work_item_artifacts ADD COLUMN grants_is char(1) CHECK(grants_is IN ('n','l','x'));",
        'ALTER TABLE orgtree.work_item_artifacts ADD CONSTRAINT work_item_artifact_id UNIQUE(id);',
        'ALTER TABLE orgtree.work_item_artifacts ADD CONSTRAINT work_item_artifact_row_id UNIQUE(item_id,id);',
    ]
    for table in R.TABLES:
        out.extend(s.rstrip(';')+';' for s in table.ddl())
        constraints = [(col, vals) for col, _, vals in
                       (*codec.markers(table.spec), *codec.enumerated(table.spec))]
        constraints.extend(codec.tagged(table.spec))
        for col,values in constraints:
            out.append(f'ALTER TABLE orgtree.{table.spec.table} ADD CONSTRAINT {ident(table.spec.table+"_"+col+"_enum")} '
                       f'CHECK({ident(col)} IN ('+','.join(map(literal,values))+'));')
    migration.compiler.statements.append(r'''
CREATE FUNCTION pg_temp.sc_list_shape(v json) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE safe json;
BEGIN
 IF v IS NULL THEN RETURN NULL; END IF;
 IF json_typeof(v)='null' THEN RETURN 'n'; END IF;
 IF json_typeof(v)<>'array' THEN RETURN 'x'; END IF;
 SELECT value INTO safe FROM orgtree.docket_safe(v);
 IF EXISTS(SELECT 1 FROM json_array_elements(safe) e WHERE json_typeof(e)<>'object') THEN RETURN 'x'; END IF;
 RETURN 'l';
END $fn$;
''')
    seat=migration.compiler.function(R.SEAT)
    delivery=migration.compiler.function(R.DELIVERY)
    grant=migration.compiler.function(R.GRANT)
    stage_array='ARRAY['+','.join(map(literal,R.STAGES))+']::text[]'
    migration.compiler.statements.append(f'''
CREATE FUNCTION pg_temp.sc_item_core(v json) RETURNS json LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE seats json:=pg_temp.sc_get(v,'review_seats'); delivery json:=pg_temp.sc_get(v,'delivery');
BEGIN
 IF pg_temp.sc_list_shape(seats) IN ('n','l') THEN v:=pg_temp.sc_drop(v,ARRAY['review_seats']); END IF;
 IF json_typeof(delivery)='object' THEN v:=pg_temp.sc_put(v,'delivery',pg_temp.sc_drop(delivery,{stage_array})); END IF;
 RETURN v;
END $fn$;
CREATE FUNCTION pg_temp.sc_item_relations(v json,item bigint) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE entries json; entry record; payload json; holder json; reviewer json; pack json; state text;
BEGIN
 entries:=pg_temp.sc_get(v,'review_seats'); state:=pg_temp.sc_list_shape(entries);
 UPDATE orgtree.work_items SET review_seats_is=state WHERE id=item;
 IF state='l' THEN
  FOR entry IN SELECT value,ord FROM json_array_elements((SELECT value FROM orgtree.docket_safe(entries))) WITH ORDINALITY x(value,ord) LOOP
   payload:=orgtree.docket_field(entries,(entry.ord-1)::text);
   pack:=pg_temp.{seat}_encode(payload);
   holder:=pg_temp.sc_get(payload,'holder'); reviewer:=pg_temp.sc_get(payload,'reviewer');
   IF json_typeof(holder)='object' AND pg_temp.sc_canonical(reviewer)=pg_temp.sc_canonical(pg_temp.sc_get(holder,'node')) THEN reviewer:=holder; END IF;
   {insert_pack(R.SEAT.table,R.SEAT,dict(item_id='item',seq='entry.ord-1',reviewer_agent_id='pg_temp.sc_current(reviewer)',holder_agent_id='pg_temp.sc_current(holder)',recheck_owner_agent_id="pg_temp.sc_current(pg_temp.sc_get(payload,'recheck_owner'))"))}
  END LOOP;
 END IF;
 entries:=pg_temp.sc_get(v,'delivery');
 IF json_typeof(entries)='object' THEN
  FOR entry IN SELECT key FROM json_each((SELECT value FROM orgtree.docket_safe(entries))) WHERE key=ANY({stage_array}) LOOP
   payload:=pg_temp.sc_get(entries,entry.key);
   state:=CASE json_typeof(payload) WHEN 'null' THEN 'n' WHEN 'object' THEN 'o' ELSE 'x' END;
   pack:=pg_temp.{delivery}_encode(CASE WHEN state='o' THEN payload ELSE '{{}}'::json END);
   IF state='x' THEN pack:=pg_temp.sc_put(pack,'extra',json_build_object('claim',payload)); END IF;
   {insert_pack(R.DELIVERY.table,R.DELIVERY,dict(item_id='item',stage='entry.key',claim_is='state'))}
  END LOOP;
 END IF;
END $fn$;
CREATE FUNCTION pg_temp.sc_restore_item(v json,item bigint) RETURNS json LANGUAGE plpgsql AS $fn$
DECLARE row record; entries json; stages json; value json; state text;
BEGIN
 SELECT review_seats_is INTO state FROM orgtree.work_items WHERE id=item;
 IF state='n' THEN v:=pg_temp.sc_put(v,'review_seats','null');
 ELSIF state='l' THEN
  entries:='[]';
  SELECT coalesce(json_agg(pg_temp.{seat}_decode(to_json(t),extra,'{{}}') ORDER BY seq),'[]'::json) INTO entries
   FROM orgtree.work_item_review_seats t WHERE item_id=item;
  v:=pg_temp.sc_put(v,'review_seats',entries);
 END IF;
 stages:=pg_temp.sc_get(v,'delivery');
 FOR row IN SELECT t.*,to_json(t) raw FROM orgtree.work_item_delivery t WHERE item_id=item LOOP
  value:=CASE row.claim_is WHEN 'n' THEN 'null'::json WHEN 'x' THEN pg_temp.sc_get(row.extra,'claim')
   ELSE pg_temp.{delivery}_decode(row.raw,row.extra,'{{}}') END;
  stages:=pg_temp.sc_put(stages,row.stage,value);
 END LOOP;
 IF json_typeof(stages)='object' THEN v:=pg_temp.sc_put(v,'delivery',stages); END IF;
 RETURN v;
END $fn$;
CREATE FUNCTION pg_temp.sc_grant_core(v json) RETURNS json LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
 IF pg_temp.sc_list_shape(pg_temp.sc_get(v,'grants')) IN ('n','l') THEN RETURN pg_temp.sc_drop(v,ARRAY['grants']); END IF;
 RETURN v;
END $fn$;
CREATE FUNCTION pg_temp.sc_grant_relations(v json,item bigint,artifact bigint) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE entries json:=pg_temp.sc_get(v,'grants'); entry record; payload json; pack json; state text;
BEGIN
 state:=pg_temp.sc_list_shape(entries);
 UPDATE orgtree.work_item_artifacts SET grants_is=state WHERE id=artifact;
 IF state='l' THEN
  FOR entry IN SELECT value,ord FROM json_array_elements((SELECT value FROM orgtree.docket_safe(entries))) WITH ORDINALITY x(value,ord) LOOP
   payload:=orgtree.docket_field(entries,(entry.ord-1)::text); pack:=pg_temp.{grant}_encode(payload);
   {insert_pack(R.GRANT.table,R.GRANT,dict(item_id='item',artifact_id='artifact',pos='entry.ord-1',agent_id="pg_temp.sc_current(pg_temp.sc_get(payload,'to'))"))}
  END LOOP;
 END IF;
END $fn$;
CREATE FUNCTION pg_temp.sc_restore_grants(v json,artifact bigint) RETURNS json LANGUAGE plpgsql AS $fn$
DECLARE state text; entries json;
BEGIN
 SELECT grants_is INTO state FROM orgtree.work_item_artifacts WHERE id=artifact;
 IF state='n' THEN RETURN pg_temp.sc_put(v,'grants','null'); END IF;
 IF state='l' THEN
  SELECT coalesce(json_agg(pg_temp.{grant}_decode(to_json(t),extra,'{{}}') ORDER BY pos),'[]'::json) INTO entries
   FROM orgtree.work_item_artifact_grants t WHERE artifact_id=artifact;
  RETURN pg_temp.sc_put(v,'grants',entries);
 END IF;
 RETURN v;
END $fn$;
''')
    fields=('manual_attention','accepted','owner','reviewer','delivery')
    migration.migrate_record('work_items',subset(D.ALPHA_WORK_ITEM,fields+('review_seats',)),subset(D.WORK_ITEM,fields),
        before='normalized:=pg_temp.sc_item_core(original);',encode_value='normalized',
        after="PERFORM pg_temp.sc_item_relations(original,old.id); UPDATE orgtree.work_items SET "
              "owner_agent_id=pg_temp.sc_current(pg_temp.sc_get(original,'owner')),"
              "reviewer_agent_id=pg_temp.sc_current(pg_temp.sc_get(original,'reviewer')) WHERE id=old.id;",
        restore='pg_temp.sc_restore_item({value},old.id)')
    migration.migrate_record('work_item_artifacts',subset(D.LEGACY_WORK_ITEM.field('artifacts').spec,('grants',)),codec.Spec('',()),
        keys=('item_id','pos'),before='normalized:=pg_temp.sc_grant_core(original);',encode_value='normalized',
        after='PERFORM pg_temp.sc_grant_relations(original,old.item_id,old.id);',
        restore='pg_temp.sc_restore_grants({value},old.id)')
    migration.migrate_record('work_item_holders',D.LEGACY_WORK_ITEM.field('holders').spec,D._HOLDERS,
        keys=('item_id','pos'),after='UPDATE orgtree.work_item_holders SET agent_id=pg_temp.sc_current(original) WHERE item_id=old.item_id AND pos=old.pos;')
    # The source object owns its nested extra. Migrating only its flattened
    # fields would move exceptional principal members to the row's top-level
    # extra and lose them when the complete event mapper decodes history.
    principals=('by','raised_by','next_actor')
    migration.migrate_record('work_item_events',
        codec.Spec('',(codec.Field('history','obj',spec=subset(D.ALPHA_SOURCE_SPECS['history'],principals)),)),
        codec.Spec('',(codec.Field('history','obj',spec=subset(D.SOURCE_SPECS['history'],principals)),)),
        where="source='history'")
    out.extend(s+';' for s in D.WORK_ITEMS.indexes if s not in D.LEGACY_WORK_ITEMS.indexes)
    out.append('CREATE INDEX work_item_holders_agent ON orgtree.work_item_holders(agent_id,item_id,pos);')


def generate(*, foundation=False):
    from orgtree.orgdb import turns
    from orgtree.orgdb.mappers import agents as A, records as N

    migration = Migration()
    out = migration.body
    # Enabling the typed deleted state is required before stamped tombstones.
    out += ["ALTER TABLE orgtree.agents DROP CONSTRAINT agents_state_enum;",
            "ALTER TABLE orgtree.agents ADD CONSTRAINT agents_state_enum CHECK(state IN ('live','archived','unrecoverable','deleted'));" ]
    migration.migrate_record('agents', subset(A.LEGACY_HOT, ('turn_est_cost','turn_est_toks')),
                             subset(A.HOT, ('turn_est_cost','turn_est_toks')))
    migration.migrate_record('lifecycle_events', subset(N.LEGACY_LIFECYCLE, ('current_candidate',)),
                             subset(N.LIFECYCLE, ('current_candidate',)))

    # Log identities and source positions are immutable. Recent membership is
    # assigned by exact reverse-greedy occurrence matching, never just n/at.
    oldturn = N.AGENT_TURNS
    turnfn = migration.compiler.function(oldturn)
    out += [
        'ALTER TABLE orgtree.agent_turns ALTER COLUMN idx DROP NOT NULL;',
        'ALTER TABLE orgtree.agent_turns ADD COLUMN recent_pos bigint;',
        'ALTER TABLE orgtree.agent_turns ADD COLUMN row_version bigint NOT NULL DEFAULT 0;',
        f"""
CREATE TEMP TABLE sc_turn_sources ON COMMIT DROP AS
 SELECT id,agent_id,idx,
  pg_temp.sc_canonical(pg_temp.{turnfn}_decode(to_json(t),extra,'{{}}')) AS exact
 FROM orgtree.agent_turns t;
CREATE INDEX sc_turn_source_match ON sc_turn_sources(agent_id,md5(exact),idx DESC);
CREATE TEMP TABLE sc_recent_sources ON COMMIT DROP AS
 SELECT agent_id,pos,
  pg_temp.sc_canonical(pg_temp.{turnfn}_decode(to_json(t),extra,'{{}}')) AS exact
 FROM orgtree.agent_recent_turns t;
DO $membership$
DECLARE old record; ceiling bigint; previous_agent bigint; chosen bigint;
BEGIN
 -- Conversion used the same latest-occurrence-first matching. Matching is
 -- one-to-one and strictly ordered even for repeated identical records.
 FOR old IN SELECT * FROM orgtree.agent_recent_turns ORDER BY agent_id,pos DESC LOOP
  IF previous_agent IS DISTINCT FROM old.agent_id THEN ceiling:=9223372036854775807; END IF;
  SELECT s.id INTO chosen FROM sc_turn_sources s
   JOIN sc_recent_sources r ON r.agent_id=old.agent_id AND r.pos=old.pos
   WHERE s.agent_id=old.agent_id AND s.idx<ceiling AND md5(s.exact)=md5(r.exact) AND s.exact=r.exact
   ORDER BY s.idx DESC,s.id DESC LIMIT 1;
  IF chosen IS NOT NULL THEN
   UPDATE orgtree.agent_turns SET recent_pos=old.pos WHERE id=chosen;
   SELECT idx INTO ceiling FROM sc_turn_sources WHERE id=chosen;
  ELSE
   INSERT INTO orgtree.agent_turns(agent_id,idx,recent_pos,{','.join(ident(c) for c,_ in codec.columns(oldturn))},extra)
    SELECT old.agent_id,NULL,old.pos,{','.join('old.'+ident(c) for c,_ in codec.columns(oldturn))},old.extra;
  END IF;
  previous_agent:=old.agent_id;
 END LOOP;
 IF EXISTS (
  SELECT agent_id,recent_pos,pg_temp.sc_canonical(pg_temp.{turnfn}_decode(to_json(t),extra,'{{}}')) AS exact
   FROM orgtree.agent_turns t WHERE recent_pos IS NOT NULL
  EXCEPT SELECT agent_id,pos,exact FROM sc_recent_sources) OR EXISTS (
  SELECT agent_id,pos,exact FROM sc_recent_sources EXCEPT
  SELECT agent_id,recent_pos,pg_temp.sc_canonical(pg_temp.{turnfn}_decode(to_json(t),extra,'{{}}'))
   FROM orgtree.agent_turns t WHERE recent_pos IS NOT NULL) THEN
  RAISE EXCEPTION 'schema conformance changed recent turn occurrences';
 END IF;
 IF EXISTS (
  SELECT id,agent_id,idx,pg_temp.sc_canonical(pg_temp.{turnfn}_decode(to_json(t),extra,'{{}}')) AS exact
   FROM orgtree.agent_turns t WHERE idx IS NOT NULL EXCEPT SELECT * FROM sc_turn_sources)
 OR EXISTS (SELECT * FROM sc_turn_sources EXCEPT
  SELECT id,agent_id,idx,pg_temp.sc_canonical(pg_temp.{turnfn}_decode(to_json(t),extra,'{{}}'))
   FROM orgtree.agent_turns t WHERE idx IS NOT NULL) THEN
  RAISE EXCEPTION 'schema conformance changed retained log identities';
 END IF;
END
$membership$;
DROP TABLE orgtree.agent_recent_turns;
ALTER TABLE orgtree.agent_turns ADD CONSTRAINT agent_turn_membership CHECK(idx IS NOT NULL OR recent_pos IS NOT NULL);
ALTER TABLE orgtree.agent_turns ADD CONSTRAINT agent_turn_recent_nonnegative CHECK(recent_pos>=0);
""",
    ]
    # The child DDL is emitted from the same current layout as new conversion.
    for statement in turns.TABLE.ddl():
        if statement.startswith('CREATE TABLE') and statement.split('(',1)[0].rsplit('.',1)[-1].strip().strip('"') != 'agent_turns':
            out.append(statement.rstrip(';')+';')
    child_writes = []
    for child in ('agent_turn_cost_unknown_fields','agent_turn_model_usage_keys'):
        child_writes.append(f"""
 INSERT INTO orgtree.{child}(turn_id,pos,value)
 SELECT old.id,ord-1,pg_temp.sc_text(value)
 FROM json_array_elements(coalesce(orgtree.docket_field(pack,'children','{child}'),'[]'::json)) WITH ORDINALITY x(value,ord);
 SELECT coalesce(json_agg(value ORDER BY pos),'[]'::json) INTO raw FROM orgtree.{child} WHERE turn_id=old.id;
 children:=pg_temp.sc_put(children,'{child}',raw);
""")
    migration.migrate_record('agent_turns', subset(oldturn, ('cost_unknown_fields','model_usage_key')),
                             subset(turns.SPEC, ('cost_unknown_fields','model_usage_key')),
                             after='\n'.join(child_writes))
    out.extend(statement.rstrip(';')+';' for statement in turns.TABLE.indexes
               if statement not in N._turns().migration_tables[0].indexes)
    out.append("CREATE INDEX agent_turns_log_at ON orgtree.agent_turns(agent_id,at DESC,id DESC) WHERE idx IS NOT NULL;")
    if not foundation:
        docket_backfill(migration)
    return migration


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--foundation-draft', action='store_true',
                        help='emit only the G6/G7/G8/G10 authoring draft; never install it')
    args = parser.parse_args()
    sql = '-- AUTHORING DRAFT: VERIFY BEFORE INSTALLING AS AN ORG MIGRATION.\n'+generate(foundation=args.foundation_draft).render()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', encoding='utf-8', newline='\r\n') as stream:
        stream.write(sql)
    print(json.dumps({'path':str(args.output),'bytes':args.output.stat().st_size,
                      'import_provenance':PROVENANCE.as_dict()}))


if __name__ == '__main__':
    main()
