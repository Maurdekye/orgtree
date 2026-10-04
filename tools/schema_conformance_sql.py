"""Author the reviewed G1-G11 SQL backfill from mapper field declarations.

This is an authoring tool, never a runtime migration hook. Only the G6/G7/G8/G10
foundation draft is available until the docket composition is finished. The
eventual migration runs alone in migrate.py's existing transaction. The
independent verifier does not import this tool, its descriptors, or mapper code.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

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
        self.body = [
            '-- Authored with tools/schema_conformance_sql.py; edit the generator.',
            '-- Alpha databases migrate in place. No legacy reconversion is used.',
            "SET LOCAL timezone='UTC';",
        ]

    def migrate_record(self, table, oldspec, newspec, *, keys=('id',), where='true',
                       prefix='', before='', after=''):
        oldfn = self.compiler.function(oldspec, prefix)
        newfn = self.compiler.function(newspec, prefix)
        oldcols, newcols = dict(codec.columns(oldspec, prefix)), dict(codec.columns(newspec, prefix))
        renamed = {}
        for column, typ in newcols.items():
            if column in oldcols and oldcols[column] != typ:
                renamed[column] = 'sc_old_'+column
                self.body.append(f'ALTER TABLE orgtree.{ident(table)} RENAME COLUMN {ident(column)} TO {ident(renamed[column])};')
            if column not in oldcols or column in renamed:
                self.body.append(f'ALTER TABLE orgtree.{ident(table)} ADD COLUMN {ident(column)} {typ};')
        restore = ''.join(
            f'raw:=pg_temp.sc_put(raw,{literal(c)},pg_temp.sc_get(raw,{literal(old)}));'
            for c, old in renamed.items())
        update = [f'{ident(c)}={cast_column("pack",c,t)}' for c, t in newcols.items()]
        update += ["extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra'))"]
        match = ' AND '.join(f't.{ident(k)}=old.{ident(k)}' for k in keys)
        assignments = ',\n '.join(update)
        self.body.append(f"""
DO $backfill$
DECLARE old record; raw json; original json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree.{ident(table)} t WHERE {where}
  ORDER BY {','.join('t.'+ident(k) for k in keys)} LOOP
  raw:=old.raw; {restore}
  original:=pg_temp.{oldfn}_decode(raw,pg_temp.sc_get(raw,'extra'),'{{}}');
  {before}
  pack:=pg_temp.{newfn}_encode(original);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(original,pg_temp.{newfn}_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            '{table} before write');
  UPDATE orgtree.{ident(table)} t SET {assignments} WHERE {match};
  {after}
  SELECT to_json(t) INTO changed FROM orgtree.{ident(table)} t WHERE {match};
  PERFORM pg_temp.sc_assert(original,pg_temp.{newfn}_decode(changed,pg_temp.sc_get(changed,'extra'),children),
                            '{table} after write');
 END LOOP;
END
$backfill$;
""")
        for column in oldcols.keys() - newcols.keys():
            self.body.append(f'ALTER TABLE orgtree.{ident(table)} DROP COLUMN {ident(column)};')
        for column in renamed.values():
            self.body.append(f'ALTER TABLE orgtree.{ident(table)} DROP COLUMN {ident(column)};')
        for column, _, values in (*codec.enumerated(newspec, prefix), *codec.markers(newspec, prefix)):
            if column not in oldcols:
                self.body.append(f'ALTER TABLE orgtree.{ident(table)} ADD CONSTRAINT '
                    f'{ident(table+"_"+column+"_enum")} CHECK({ident(column)} IN ('+
                    ','.join(map(literal, values))+'));')

    def render(self):
        return '\n'.join(self.compiler.statements + self.body) + '\n'


def generate():
    from orgtree.orgdb import turns
    from orgtree.orgdb.mappers import agents as A, records as N

    migration = Migration()
    out = migration.body
    # Enabling the typed deleted state is required before stamped tombstones.
    out += ["ALTER TABLE orgtree.agents DROP CONSTRAINT agents_state_enum;",
            "ALTER TABLE orgtree.agents ADD CONSTRAINT agents_state_enum CHECK(state IN ('live','archived','unrecoverable','deleted'));" ]
    migration.migrate_record('agents', subset(A.LEGACY_HOT, ('turn_est_cost','turn_est_toks','state')),
                             subset(A.HOT, ('turn_est_cost','turn_est_toks','state')))
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
    # Remaining docket relations are composed below. Their mapping uses the
    # same compiler, but existing row identities are retained rather than reset.
    return migration


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--foundation-draft', action='store_true',
                        help='emit only the G6/G7/G8/G10 authoring draft; never install it')
    args = parser.parse_args()
    if not args.foundation_draft:
        parser.error('G1-G5/G11 composition is unfinished; only --foundation-draft is available')
    sql = '-- INCOMPLETE AUTHORING DRAFT: DO NOT INSTALL AS AN ORG MIGRATION.\n'+generate().render()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', encoding='utf-8', newline='\r\n') as stream:
        stream.write(sql)
    print(json.dumps({'path':str(args.output),'bytes':args.output.stat().st_size,
                      'import_provenance':PROVENANCE.as_dict()}))


if __name__ == '__main__':
    main()
