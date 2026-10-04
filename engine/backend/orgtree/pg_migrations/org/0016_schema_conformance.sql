-- G1-G11 normalized agent and docket records; alpha data is checked in this transaction.

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


CREATE FUNCTION pg_temp.sc_record_1_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['turn_est_cost','turn_est_toks','state']::text[]);
 x:=pg_temp.sc_get(v,'turn_est_cost');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'turn_est_cost',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'turn_est_cost',x);

 ELSE e:=pg_temp.sc_put(e,'turn_est_cost',x); END IF; END IF;
x:=pg_temp.sc_get(v,'turn_est_toks');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'turn_est_toks',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'turn_est_toks',x);

 ELSE e:=pg_temp.sc_put(e,'turn_est_toks',x); END IF; END IF;
x:=pg_temp.sc_get(v,'state');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'state',x);
 ELSIF pg_temp.sc_fits('text',x) AND pg_temp.sc_text(x)=ANY(ARRAY['live','archived','unrecoverable']) THEN r:=pg_temp.sc_put(r,'state',x);

 ELSE e:=pg_temp.sc_put(e,'state',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_1_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_cost'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'turn_est_cost',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_toks'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'turn_est_toks',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'state'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'state',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_2_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['turn_est_cost','turn_est_toks','state']::text[]);
 x:=pg_temp.sc_get(v,'turn_est_cost');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'turn_est_cost_is','"n"'::json);
 ELSIF json_typeof(x)='array' THEN
  IF json_array_length(x)=2 AND pg_temp.sc_text(orgtree.docket_field(x,'0'))='i'
   AND json_typeof(orgtree.docket_field(x,'1'))='number' AND orgtree.docket_field(x,'1')::text ~ '^-?[0-9]+$' THEN
   r:=pg_temp.sc_put(r,'turn_est_cost_is','"l"'::json);r:=pg_temp.sc_put(r,'turn_est_cost_kind','"i"'::json);r:=pg_temp.sc_put(r,'turn_est_cost_integer',orgtree.docket_field(x,'1'));
  ELSIF json_array_length(x)=3 AND pg_temp.sc_text(orgtree.docket_field(x,'0'))='f'
   AND pg_temp.sc_fits('float',orgtree.docket_field(x,'1')) AND pg_temp.sc_fits('float',orgtree.docket_field(x,'2')) THEN
   r:=pg_temp.sc_put(r,'turn_est_cost_is','"l"'::json);r:=pg_temp.sc_put(r,'turn_est_cost_kind','"f"'::json);r:=pg_temp.sc_put(r,'turn_est_cost_float',orgtree.docket_field(x,'1'));r:=pg_temp.sc_put(r,'turn_est_cost_compensation',orgtree.docket_field(x,'2'));
  ELSE r:=pg_temp.sc_put(r,'turn_est_cost_is','"x"'::json); e:=pg_temp.sc_put(e,'turn_est_cost',x); END IF;
 ELSE r:=pg_temp.sc_put(r,'turn_est_cost_is','"x"'::json); e:=pg_temp.sc_put(e,'turn_est_cost',x); END IF; END IF;
x:=pg_temp.sc_get(v,'turn_est_toks');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'turn_est_toks_is','"n"'::json);
 ELSIF json_typeof(x)='array' THEN
  IF json_array_length(x)=2 AND pg_temp.sc_text(orgtree.docket_field(x,'0'))='i'
   AND json_typeof(orgtree.docket_field(x,'1'))='number' AND orgtree.docket_field(x,'1')::text ~ '^-?[0-9]+$' THEN
   r:=pg_temp.sc_put(r,'turn_est_toks_is','"l"'::json);r:=pg_temp.sc_put(r,'turn_est_toks_kind','"i"'::json);r:=pg_temp.sc_put(r,'turn_est_toks_integer',orgtree.docket_field(x,'1'));
  ELSIF json_array_length(x)=3 AND pg_temp.sc_text(orgtree.docket_field(x,'0'))='f'
   AND pg_temp.sc_fits('float',orgtree.docket_field(x,'1')) AND pg_temp.sc_fits('float',orgtree.docket_field(x,'2')) THEN
   r:=pg_temp.sc_put(r,'turn_est_toks_is','"l"'::json);r:=pg_temp.sc_put(r,'turn_est_toks_kind','"f"'::json);r:=pg_temp.sc_put(r,'turn_est_toks_float',orgtree.docket_field(x,'1'));r:=pg_temp.sc_put(r,'turn_est_toks_compensation',orgtree.docket_field(x,'2'));
  ELSE r:=pg_temp.sc_put(r,'turn_est_toks_is','"x"'::json); e:=pg_temp.sc_put(e,'turn_est_toks',x); END IF;
 ELSE r:=pg_temp.sc_put(r,'turn_est_toks_is','"x"'::json); e:=pg_temp.sc_put(e,'turn_est_toks',x); END IF; END IF;
x:=pg_temp.sc_get(v,'state');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'state',x);
 ELSIF pg_temp.sc_fits('text',x) AND pg_temp.sc_text(x)=ANY(ARRAY['live','archived','unrecoverable','deleted']) THEN r:=pg_temp.sc_put(r,'state',x);

 ELSE e:=pg_temp.sc_put(e,'state',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_2_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_cost_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'turn_est_cost','null');
ELSIF shape='l' THEN IF pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_cost_kind')))='i' THEN
 v:=pg_temp.sc_put(v,'turn_est_cost',json_build_array('i',pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_cost_integer'))));
 ELSE v:=pg_temp.sc_put(v,'turn_est_cost',json_build_array('f',pg_temp.sc_float(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_cost_float'))::text::double precision),pg_temp.sc_float(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_cost_compensation'))::text::double precision))); END IF; END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_toks_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'turn_est_toks','null');
ELSIF shape='l' THEN IF pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_toks_kind')))='i' THEN
 v:=pg_temp.sc_put(v,'turn_est_toks',json_build_array('i',pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_toks_integer'))));
 ELSE v:=pg_temp.sc_put(v,'turn_est_toks',json_build_array('f',pg_temp.sc_float(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_toks_float'))::text::double precision),pg_temp.sc_float(pg_temp.sc_nonnull(pg_temp.sc_get(r,'turn_est_toks_compensation'))::text::double precision))); END IF; END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'state'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'state',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_3_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['current_candidate']::text[]);
 x:=pg_temp.sc_get(v,'current_candidate');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'current_candidate_null','true'::json);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'current_candidate',x);

 ELSE e:=pg_temp.sc_put(e,'current_candidate',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_3_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'current_candidate'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'current_candidate',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'current_candidate_null'))::text='true' THEN v:=pg_temp.sc_put(v,'current_candidate','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_4_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['current_candidate']::text[]);
 x:=pg_temp.sc_get(v,'current_candidate');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'current_candidate_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'current_candidate',x);

 ELSE e:=pg_temp.sc_put(e,'current_candidate',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_4_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'current_candidate'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'current_candidate',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'current_candidate_null'))::text='true' THEN v:=pg_temp.sc_put(v,'current_candidate','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_5_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['n','at','cost','ms','toks','denials','approvals','ran_as','killed','estimated','cost_complete','cost_source','cost_unknown_fields','route','reported','model_usage_key']::text[]);
 x:=pg_temp.sc_get(v,'n');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'n',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'n',x);

 ELSE e:=pg_temp.sc_put(e,'n',x); END IF; END IF;
x:=pg_temp.sc_get(v,'at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'at',x);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'cost');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'cost',x);
 ELSIF pg_temp.sc_fits('float',x) THEN r:=pg_temp.sc_put(r,'cost',x);

 ELSE e:=pg_temp.sc_put(e,'cost',x); END IF; END IF;
x:=pg_temp.sc_get(v,'ms');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'ms_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'ms',x);

 ELSE e:=pg_temp.sc_put(e,'ms',x); END IF; END IF;
x:=pg_temp.sc_get(v,'toks');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'toks',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'toks',x);

 ELSE e:=pg_temp.sc_put(e,'toks',x); END IF; END IF;
x:=pg_temp.sc_get(v,'denials');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'denials',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'denials',x);

 ELSE e:=pg_temp.sc_put(e,'denials',x); END IF; END IF;
x:=pg_temp.sc_get(v,'approvals');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'approvals',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'approvals',x);

 ELSE e:=pg_temp.sc_put(e,'approvals',x); END IF; END IF;
x:=pg_temp.sc_get(v,'ran_as');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'ran_as',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'ran_as',x);

 ELSE e:=pg_temp.sc_put(e,'ran_as',x); END IF; END IF;
x:=pg_temp.sc_get(v,'killed');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'killed',x);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'killed',x);

 ELSE e:=pg_temp.sc_put(e,'killed',x); END IF; END IF;
x:=pg_temp.sc_get(v,'estimated');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'estimated',x);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'estimated',x);

 ELSE e:=pg_temp.sc_put(e,'estimated',x); END IF; END IF;
x:=pg_temp.sc_get(v,'cost_complete');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'cost_complete',x);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'cost_complete',x);

 ELSE e:=pg_temp.sc_put(e,'cost_complete',x); END IF; END IF;
x:=pg_temp.sc_get(v,'cost_source');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'cost_source',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'cost_source',x);

 ELSE e:=pg_temp.sc_put(e,'cost_source',x); END IF; END IF;
x:=pg_temp.sc_get(v,'cost_unknown_fields');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'cost_unknown_fields',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'cost_unknown_fields',x);

 ELSE e:=pg_temp.sc_put(e,'cost_unknown_fields',x); END IF; END IF;
x:=pg_temp.sc_get(v,'route');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'route',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'route',x);

 ELSE e:=pg_temp.sc_put(e,'route',x); END IF; END IF;
x:=pg_temp.sc_get(v,'reported');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'reported',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'reported',x);

 ELSE e:=pg_temp.sc_put(e,'reported',x); END IF; END IF;
x:=pg_temp.sc_get(v,'model_usage_key');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'model_usage_key',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'model_usage_key',x);

 ELSE e:=pg_temp.sc_put(e,'model_usage_key',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_5_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'n'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'n',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'at')))));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'cost'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'cost',pg_temp.sc_float(x::text::double precision));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'ms'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'ms',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'ms_null'))::text='true' THEN v:=pg_temp.sc_put(v,'ms','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'toks'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'toks',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'denials'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'denials',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'approvals'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'approvals',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'ran_as'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'ran_as',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'killed'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'killed',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'estimated'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'estimated',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'cost_complete'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'cost_complete',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'cost_source'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'cost_source',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'cost_unknown_fields'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'cost_unknown_fields',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'route'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'route',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reported'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'reported',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_key'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'model_usage_key',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_6_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['cost_unknown_fields','model_usage_key']::text[]);
 x:=pg_temp.sc_get(v,'cost_unknown_fields');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'cost_unknown_fields',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'cost_unknown_fields',x);

 ELSE e:=pg_temp.sc_put(e,'cost_unknown_fields',x); END IF; END IF;
x:=pg_temp.sc_get(v,'model_usage_key');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'model_usage_key',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'model_usage_key',x);

 ELSE e:=pg_temp.sc_put(e,'model_usage_key',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_6_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'cost_unknown_fields'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'cost_unknown_fields',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_key'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'model_usage_key',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_8_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['asked','matched','keys']::text[]);
 x:=pg_temp.sc_get(v,'asked');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'model_usage_asked_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'model_usage_asked',x);

 ELSE e:=pg_temp.sc_put(e,'asked',x); END IF; END IF;
x:=pg_temp.sc_get(v,'matched');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'model_usage_matched_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'model_usage_matched',x);

 ELSE e:=pg_temp.sc_put(e,'matched',x); END IF; END IF;
x:=pg_temp.sc_get(v,'keys');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'model_usage_keys_is','"n"'::json);
 ELSIF json_typeof(x)='array' AND NOT EXISTS(
  SELECT 1 FROM json_array_elements((SELECT value FROM orgtree.docket_safe(x))) a(value)
  WHERE NOT pg_temp.sc_fits('text',orgtree.docket_restore(a.value,(SELECT marker FROM orgtree.docket_safe(x))))) THEN
  r:=pg_temp.sc_put(r,'model_usage_keys_is','"l"'::json); children:=pg_temp.sc_put(children,'agent_turn_model_usage_keys',x);
 ELSE r:=pg_temp.sc_put(r,'model_usage_keys_is','"x"'::json); e:=pg_temp.sc_put(e,'keys',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_8_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_asked'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'asked',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_asked_null'))::text='true' THEN v:=pg_temp.sc_put(v,'asked','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_matched'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'matched',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_matched_null'))::text='true' THEN v:=pg_temp.sc_put(v,'matched','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_keys_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'keys','null');
ELSIF shape='l' THEN v:=pg_temp.sc_put(v,'keys',coalesce(pg_temp.sc_get(children,'agent_turn_model_usage_keys'),'[]'::json)); END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_7_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['cost_unknown_fields','model_usage_key']::text[]);
 x:=pg_temp.sc_get(v,'cost_unknown_fields');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'cost_unknown_fields_is','"n"'::json);
 ELSIF json_typeof(x)='array' AND NOT EXISTS(
  SELECT 1 FROM json_array_elements((SELECT value FROM orgtree.docket_safe(x))) a(value)
  WHERE NOT pg_temp.sc_fits('text',orgtree.docket_restore(a.value,(SELECT marker FROM orgtree.docket_safe(x))))) THEN
  r:=pg_temp.sc_put(r,'cost_unknown_fields_is','"l"'::json); children:=pg_temp.sc_put(children,'agent_turn_cost_unknown_fields',x);
 ELSE r:=pg_temp.sc_put(r,'cost_unknown_fields_is','"x"'::json); e:=pg_temp.sc_put(e,'cost_unknown_fields',x); END IF; END IF;
x:=pg_temp.sc_get(v,'model_usage_key');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'model_usage_key_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'model_usage_key_is','"o"'::json);
  sub:=pg_temp.sc_record_8_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'model_usage_key',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'model_usage_key_is','"x"'::json); e:=pg_temp.sc_put(e,'model_usage_key',x); END IF; END IF;
IF json_typeof(pg_temp.sc_get(v,'model_usage_key'))='array' THEN
 sub:=pg_temp.sc_record_8_encode(json_build_object('keys',pg_temp.sc_get(v,'model_usage_key')));
 IF pg_temp.sc_text(orgtree.docket_field(sub,'row','model_usage_keys_is'))='l' THEN
  r:=pg_temp.sc_put(r,'model_usage_key_is','"l"'::json); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children')); e:=pg_temp.sc_drop(e,ARRAY['model_usage_key']); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_7_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'cost_unknown_fields_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'cost_unknown_fields','null');
ELSIF shape='l' THEN v:=pg_temp.sc_put(v,'cost_unknown_fields',coalesce(pg_temp.sc_get(children,'agent_turn_cost_unknown_fields'),'[]'::json)); END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'model_usage_key_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'model_usage_key','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'model_usage_key',pg_temp.sc_record_8_decode(r,pg_temp.sc_get(e,'model_usage_key'),children)); END IF;
IF shape='l' THEN sub:=pg_temp.sc_record_8_decode(r,'{}',children); v:=pg_temp.sc_put(v,'model_usage_key',pg_temp.sc_get(sub,'keys')); END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_9_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['seat_id','generation']::text[]);
 x:=pg_temp.sc_get(v,'seat_id');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'seat_id',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'lineage_born',x);

 ELSE e:=pg_temp.sc_put(e,'seat_id',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_9_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'lineage_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'seat_id',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_10_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['state','seat_id','generation']::text[]);
 x:=pg_temp.sc_get(v,'state');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'state',x);
 ELSIF pg_temp.sc_fits('text',x) AND pg_temp.sc_text(x)=ANY(ARRAY['live','archived','unrecoverable','deleted']) THEN r:=pg_temp.sc_put(r,'state',x);

 ELSE e:=pg_temp.sc_put(e,'state',x); END IF; END IF;
x:=pg_temp.sc_get(v,'seat_id');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'seat_id',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'lineage_born',x);

 ELSE e:=pg_temp.sc_put(e,'seat_id',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_10_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'state'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'state',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'lineage_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'seat_id',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE TEMP TABLE sc_python_nonprintable(lo int,hi int) ON COMMIT DROP;
INSERT INTO sc_python_nonprintable VALUES (0,31),(127,160),(173,173),(888,889),(896,899),(907,907),(909,909),(930,930),(1328,1328),(1367,1368),(1419,1420),(1424,1424),(1480,1487),(1515,1518),(1525,1541),(1564,1564),(1757,1757),(1806,1807),(1867,1868),(1970,1983),(2043,2044),(2094,2095),(2111,2111),(2140,2141),(2143,2143),(2155,2159),(2191,2199),(2274,2274),(2436,2436),(2445,2446),(2449,2450),(2473,2473),(2481,2481),(2483,2485),(2490,2491),(2501,2502),(2505,2506),(2511,2518),(2520,2523),(2526,2526),(2532,2533),(2559,2560),(2564,2564),(2571,2574),(2577,2578),(2601,2601),(2609,2609),(2612,2612),(2615,2615),(2618,2619),(2621,2621),(2627,2630),(2633,2634),(2638,2640),(2642,2648),(2653,2653),(2655,2661),(2679,2688),(2692,2692),(2702,2702),(2706,2706),(2729,2729),(2737,2737),(2740,2740),(2746,2747),(2758,2758),(2762,2762),(2766,2767),(2769,2783),(2788,2789),(2802,2808),(2816,2816),(2820,2820),(2829,2830),(2833,2834),(2857,2857),(2865,2865),(2868,2868),(2874,2875),(2885,2886),(2889,2890),(2894,2900),(2904,2907),(2910,2910),(2916,2917),(2936,2945),(2948,2948),(2955,2957),(2961,2961),(2966,2968),(2971,2971),(2973,2973),(2976,2978),(2981,2983),(2987,2989),(3002,3005),(3011,3013),(3017,3017),(3022,3023),(3025,3030),(3032,3045),(3067,3071),(3085,3085),(3089,3089),(3113,3113),(3130,3131),(3141,3141),(3145,3145),(3150,3156),(3159,3159),(3163,3164),(3166,3167),(3172,3173),(3184,3190),(3213,3213),(3217,3217),(3241,3241),(3252,3252),(3258,3259),(3269,3269),(3273,3273),(3278,3284),(3287,3292),(3295,3295),(3300,3301),(3312,3312),(3316,3327),(3341,3341),(3345,3345),(3397,3397),(3401,3401),(3408,3411),(3428,3429),(3456,3456),(3460,3460),(3479,3481),(3506,3506),(3516,3516),(3518,3519),(3527,3529),(3531,3534),(3541,3541),(3543,3543),(3552,3557),(3568,3569),(3573,3584),(3643,3646),(3676,3712),(3715,3715),(3717,3717),(3723,3723),(3748,3748),(3750,3750),(3774,3775),(3781,3781),(3783,3783),(3791,3791),(3802,3803),(3808,3839),(3912,3912),(3949,3952),(3992,3992),(4029,4029),(4045,4045),(4059,4095),(4294,4294),(4296,4300),(4302,4303),(4681,4681),(4686,4687),(4695,4695),(4697,4697),(4702,4703),(4745,4745),(4750,4751),(4785,4785),(4790,4791),(4799,4799),(4801,4801),(4806,4807),(4823,4823),(4881,4881),(4886,4887),(4955,4956),(4989,4991),(5018,5023),(5110,5111),(5118,5119),(5760,5760),(5789,5791),(5881,5887),(5910,5918),(5943,5951),(5972,5983),(5997,5997),(6001,6001),(6004,6015),(6110,6111),(6122,6127),(6138,6143),(6158,6158),(6170,6175),(6265,6271),(6315,6319),(6390,6399),(6431,6431),(6444,6447),(6460,6463),(6465,6467),(6510,6511),(6517,6527),(6572,6575),(6602,6607),(6619,6621),(6684,6685),(6751,6751),(6781,6782),(6794,6799),(6810,6815),(6830,6831),(6863,6911),(6989,6991),(7039,7039),(7156,7163),(7224,7226),(7242,7244),(7305,7311),(7355,7356),(7368,7375),(7419,7423),(7958,7959),(7966,7967),(8006,8007),(8014,8015),(8024,8024),(8026,8026),(8028,8028),(8030,8030),(8062,8063),(8117,8117),(8133,8133),(8148,8149),(8156,8156),(8176,8177),(8181,8181),(8191,8207),(8232,8239),(8287,8303),(8306,8307),(8335,8335),(8349,8351),(8385,8399),(8433,8447),(8588,8591),(9255,9279),(9291,9311),(11124,11125),(11158,11158),(11508,11512),(11558,11558),(11560,11564),(11566,11567),(11624,11630),(11633,11646),(11671,11679),(11687,11687),(11695,11695),(11703,11703),(11711,11711),(11719,11719),(11727,11727),(11735,11735),(11743,11743),(11870,11903),(11930,11930),(12020,12031),(12246,12271),(12288,12288),(12352,12352),(12439,12440),(12544,12548),(12592,12592),(12687,12687),(12772,12782),(12831,12831),(42125,42127),(42183,42191),(42540,42559),(42744,42751),(42955,42959),(42962,42962),(42964,42964),(42970,42993),(43053,43055),(43066,43071),(43128,43135),(43206,43213),(43226,43231),(43348,43358),(43389,43391),(43470,43470),(43482,43485),(43519,43519),(43575,43583),(43598,43599),(43610,43611),(43715,43738),(43767,43776),(43783,43784),(43791,43792),(43799,43807),(43815,43815),(43823,43823),(43884,43887),(44014,44015),(44026,44031),(55204,55215),(55239,55242),(55292,63743),(64110,64111),(64218,64255),(64263,64274),(64280,64284),(64311,64311),(64317,64317),(64319,64319),(64322,64322),(64325,64325),(64451,64466),(64912,64913),(64968,64974),(64976,65007),(65050,65055),(65107,65107),(65127,65127),(65132,65135),(65141,65141),(65277,65280),(65471,65473),(65480,65481),(65488,65489),(65496,65497),(65501,65503),(65511,65511),(65519,65531),(65534,65535),(65548,65548),(65575,65575),(65595,65595),(65598,65598),(65614,65615),(65630,65663),(65787,65791),(65795,65798),(65844,65846),(65935,65935),(65949,65951),(65953,65999),(66046,66175),(66205,66207),(66257,66271),(66300,66303),(66340,66348),(66379,66383),(66427,66431),(66462,66462),(66500,66503),(66518,66559),(66718,66719),(66730,66735),(66772,66775),(66812,66815),(66856,66863),(66916,66926),(66939,66939),(66955,66955),(66963,66963),(66966,66966),(66978,66978),(66994,66994),(67002,67002),(67005,67071),(67383,67391),(67414,67423),(67432,67455),(67462,67462),(67505,67505),(67515,67583),(67590,67591),(67593,67593),(67638,67638),(67641,67643),(67645,67646),(67670,67670),(67743,67750),(67760,67807),(67827,67827),(67830,67834),(67868,67870),(67898,67902),(67904,67967),(68024,68027),(68048,68049),(68100,68100),(68103,68107),(68116,68116),(68120,68120),(68150,68151),(68155,68158),(68169,68175),(68185,68191),(68256,68287),(68327,68330),(68343,68351),(68406,68408),(68438,68439),(68467,68471),(68498,68504),(68509,68520),(68528,68607),(68681,68735),(68787,68799),(68851,68857),(68904,68911),(68922,69215),(69247,69247),(69290,69290),(69294,69295),(69298,69372),(69416,69423),(69466,69487),(69514,69551),(69580,69599),(69623,69631),(69710,69713),(69750,69758),(69821,69821),(69827,69839),(69865,69871),(69882,69887),(69941,69941),(69960,69967),(70007,70015),(70112,70112),(70133,70143),(70162,70162),(70210,70271),(70279,70279),(70281,70281),(70286,70286),(70302,70302),(70314,70319),(70379,70383),(70394,70399),(70404,70404),(70413,70414),(70417,70418),(70441,70441),(70449,70449),(70452,70452),(70458,70458),(70469,70470),(70473,70474),(70478,70479),(70481,70486),(70488,70492),(70500,70501),(70509,70511),(70517,70655),(70748,70748),(70754,70783),(70856,70863),(70874,71039),(71094,71095),(71134,71167),(71237,71247),(71258,71263),(71277,71295),(71354,71359),(71370,71423),(71451,71452),(71468,71471),(71495,71679),(71740,71839),(71923,71934),(71943,71944),(71946,71947),(71956,71956),(71959,71959),(71990,71990),(71993,71994),(72007,72015),(72026,72095),(72104,72105),(72152,72153),(72165,72191),(72264,72271),(72355,72367),(72441,72447),(72458,72703),(72713,72713),(72759,72759),(72774,72783),(72813,72815),(72848,72849),(72872,72872),(72887,72959),(72967,72967),(72970,72970),(73015,73017),(73019,73019),(73022,73022),(73032,73039),(73050,73055),(73062,73062),(73065,73065),(73103,73103),(73106,73106),(73113,73119),(73130,73439),(73465,73471),(73489,73489),(73531,73533),(73562,73647),(73649,73663),(73714,73726),(74650,74751),(74863,74863),(74869,74879),(75076,77711),(77811,77823),(78896,78911),(78934,82943),(83527,92159),(92729,92735),(92767,92767),(92778,92781),(92863,92863),(92874,92879),(92910,92911),(92918,92927),(92998,93007),(93018,93018),(93026,93026),(93048,93052),(93072,93759),(93851,93951),(94027,94030),(94088,94094),(94112,94175),(94181,94191),(94194,94207),(100344,100351),(101590,101631),(101641,110575),(110580,110580),(110588,110588),(110591,110591),(110883,110897),(110899,110927),(110931,110932),(110934,110947),(110952,110959),(111356,113663),(113771,113775),(113789,113791),(113801,113807),(113818,113819),(113824,118527),(118574,118575),(118599,118607),(118724,118783),(119030,119039),(119079,119080),(119155,119162),(119275,119295),(119366,119487),(119508,119519),(119540,119551),(119639,119647),(119673,119807),(119893,119893),(119965,119965),(119968,119969),(119971,119972),(119975,119976),(119981,119981),(119994,119994),(119996,119996),(120004,120004),(120070,120070),(120075,120076),(120085,120085),(120093,120093),(120122,120122),(120127,120127),(120133,120133),(120135,120137),(120145,120145),(120486,120487),(120780,120781),(121484,121498),(121504,121504),(121520,122623),(122655,122660),(122667,122879),(122887,122887),(122905,122906),(122914,122914),(122917,122917),(122923,122927),(122990,123022),(123024,123135),(123181,123183),(123198,123199),(123210,123213),(123216,123535),(123567,123583),(123642,123646),(123648,124111),(124154,124895),(124903,124903),(124908,124908),(124911,124911),(124927,124927),(125125,125126),(125143,125183),(125260,125263),(125274,125277),(125280,126064),(126133,126208),(126270,126463),(126468,126468),(126496,126496),(126499,126499),(126501,126502),(126504,126504),(126515,126515),(126520,126520),(126522,126522),(126524,126529),(126531,126534),(126536,126536),(126538,126538),(126540,126540),(126544,126544),(126547,126547),(126549,126550),(126552,126552),(126554,126554),(126556,126556),(126558,126558),(126560,126560),(126563,126563),(126565,126566),(126571,126571),(126579,126579),(126584,126584),(126589,126589),(126591,126591),(126602,126602),(126620,126624),(126628,126628),(126634,126634),(126652,126703),(126706,126975),(127020,127023),(127124,127135),(127151,127152),(127168,127168),(127184,127184),(127222,127231),(127406,127461),(127491,127503),(127548,127551),(127561,127567),(127570,127583),(127590,127743),(128728,128731),(128749,128751),(128765,128767),(128887,128890),(128986,128991),(129004,129007),(129009,129023),(129036,129039),(129096,129103),(129114,129119),(129160,129167),(129198,129199),(129202,129279),(129620,129631),(129646,129647),(129661,129663),(129673,129679),(129726,129726),(129734,129741),(129756,129759),(129769,129775),(129785,129791),(129939,129939),(129995,130031),(130042,131071),(173792,173823),(177978,177983),(178206,178207),(183970,183983),(191457,191471),(192094,194559),(195102,196607),(201547,201551),(205744,917759),(918000,1114111);
CREATE TEMP TABLE sc_python_chars(code int PRIMARY KEY,digit int,space boolean) ON COMMIT DROP;
INSERT INTO sc_python_chars VALUES (9,NULL,true),(10,NULL,true),(11,NULL,true),(12,NULL,true),(13,NULL,true),(28,NULL,true),(29,NULL,true),(30,NULL,true),(31,NULL,true),(32,NULL,true),(48,0,false),(49,1,false),(50,2,false),(51,3,false),(52,4,false),(53,5,false),(54,6,false),(55,7,false),(56,8,false),(57,9,false),(133,NULL,true),(160,NULL,true),(1632,0,false),(1633,1,false),(1634,2,false),(1635,3,false),(1636,4,false),(1637,5,false),(1638,6,false),(1639,7,false),(1640,8,false),(1641,9,false),(1776,0,false),(1777,1,false),(1778,2,false),(1779,3,false),(1780,4,false),(1781,5,false),(1782,6,false),(1783,7,false),(1784,8,false),(1785,9,false),(1984,0,false),(1985,1,false),(1986,2,false),(1987,3,false),(1988,4,false),(1989,5,false),(1990,6,false),(1991,7,false),(1992,8,false),(1993,9,false),(2406,0,false),(2407,1,false),(2408,2,false),(2409,3,false),(2410,4,false),(2411,5,false),(2412,6,false),(2413,7,false),(2414,8,false),(2415,9,false),(2534,0,false),(2535,1,false),(2536,2,false),(2537,3,false),(2538,4,false),(2539,5,false),(2540,6,false),(2541,7,false),(2542,8,false),(2543,9,false),(2662,0,false),(2663,1,false),(2664,2,false),(2665,3,false),(2666,4,false),(2667,5,false),(2668,6,false),(2669,7,false),(2670,8,false),(2671,9,false),(2790,0,false),(2791,1,false),(2792,2,false),(2793,3,false),(2794,4,false),(2795,5,false),(2796,6,false),(2797,7,false),(2798,8,false),(2799,9,false),(2918,0,false),(2919,1,false),(2920,2,false),(2921,3,false),(2922,4,false),(2923,5,false),(2924,6,false),(2925,7,false),(2926,8,false),(2927,9,false),(3046,0,false),(3047,1,false),(3048,2,false),(3049,3,false),(3050,4,false),(3051,5,false),(3052,6,false),(3053,7,false),(3054,8,false),(3055,9,false),(3174,0,false),(3175,1,false),(3176,2,false),(3177,3,false),(3178,4,false),(3179,5,false),(3180,6,false),(3181,7,false),(3182,8,false),(3183,9,false),(3302,0,false),(3303,1,false),(3304,2,false),(3305,3,false),(3306,4,false),(3307,5,false),(3308,6,false),(3309,7,false),(3310,8,false),(3311,9,false),(3430,0,false),(3431,1,false),(3432,2,false),(3433,3,false),(3434,4,false),(3435,5,false),(3436,6,false),(3437,7,false),(3438,8,false),(3439,9,false),(3558,0,false),(3559,1,false),(3560,2,false),(3561,3,false),(3562,4,false),(3563,5,false),(3564,6,false),(3565,7,false),(3566,8,false),(3567,9,false),(3664,0,false),(3665,1,false),(3666,2,false),(3667,3,false),(3668,4,false),(3669,5,false),(3670,6,false),(3671,7,false),(3672,8,false),(3673,9,false),(3792,0,false),(3793,1,false),(3794,2,false),(3795,3,false),(3796,4,false),(3797,5,false),(3798,6,false),(3799,7,false),(3800,8,false),(3801,9,false),(3872,0,false),(3873,1,false),(3874,2,false),(3875,3,false),(3876,4,false),(3877,5,false),(3878,6,false),(3879,7,false),(3880,8,false),(3881,9,false),(4160,0,false),(4161,1,false),(4162,2,false),(4163,3,false),(4164,4,false),(4165,5,false),(4166,6,false),(4167,7,false),(4168,8,false),(4169,9,false),(4240,0,false),(4241,1,false),(4242,2,false),(4243,3,false),(4244,4,false),(4245,5,false),(4246,6,false),(4247,7,false),(4248,8,false),(4249,9,false),(5760,NULL,true),(6112,0,false),(6113,1,false),(6114,2,false),(6115,3,false),(6116,4,false),(6117,5,false),(6118,6,false),(6119,7,false),(6120,8,false),(6121,9,false),(6160,0,false),(6161,1,false),(6162,2,false),(6163,3,false),(6164,4,false),(6165,5,false),(6166,6,false),(6167,7,false),(6168,8,false),(6169,9,false),(6470,0,false),(6471,1,false),(6472,2,false),(6473,3,false),(6474,4,false),(6475,5,false),(6476,6,false),(6477,7,false),(6478,8,false),(6479,9,false),(6608,0,false),(6609,1,false),(6610,2,false),(6611,3,false),(6612,4,false),(6613,5,false),(6614,6,false),(6615,7,false),(6616,8,false),(6617,9,false),(6784,0,false),(6785,1,false),(6786,2,false),(6787,3,false),(6788,4,false),(6789,5,false),(6790,6,false),(6791,7,false),(6792,8,false),(6793,9,false),(6800,0,false),(6801,1,false),(6802,2,false),(6803,3,false),(6804,4,false),(6805,5,false),(6806,6,false),(6807,7,false),(6808,8,false),(6809,9,false),(6992,0,false),(6993,1,false),(6994,2,false),(6995,3,false),(6996,4,false),(6997,5,false),(6998,6,false),(6999,7,false),(7000,8,false),(7001,9,false),(7088,0,false),(7089,1,false),(7090,2,false),(7091,3,false),(7092,4,false),(7093,5,false),(7094,6,false),(7095,7,false),(7096,8,false),(7097,9,false),(7232,0,false),(7233,1,false),(7234,2,false),(7235,3,false),(7236,4,false),(7237,5,false),(7238,6,false),(7239,7,false),(7240,8,false),(7241,9,false),(7248,0,false),(7249,1,false),(7250,2,false),(7251,3,false),(7252,4,false),(7253,5,false),(7254,6,false),(7255,7,false),(7256,8,false),(7257,9,false),(8192,NULL,true),(8193,NULL,true),(8194,NULL,true),(8195,NULL,true),(8196,NULL,true),(8197,NULL,true),(8198,NULL,true),(8199,NULL,true),(8200,NULL,true),(8201,NULL,true),(8202,NULL,true),(8232,NULL,true),(8233,NULL,true),(8239,NULL,true),(8287,NULL,true),(12288,NULL,true),(42528,0,false),(42529,1,false),(42530,2,false),(42531,3,false),(42532,4,false),(42533,5,false),(42534,6,false),(42535,7,false),(42536,8,false),(42537,9,false),(43216,0,false),(43217,1,false),(43218,2,false),(43219,3,false),(43220,4,false),(43221,5,false),(43222,6,false),(43223,7,false),(43224,8,false),(43225,9,false),(43264,0,false),(43265,1,false),(43266,2,false),(43267,3,false),(43268,4,false),(43269,5,false),(43270,6,false),(43271,7,false),(43272,8,false),(43273,9,false),(43472,0,false),(43473,1,false),(43474,2,false),(43475,3,false),(43476,4,false),(43477,5,false),(43478,6,false),(43479,7,false),(43480,8,false),(43481,9,false),(43504,0,false),(43505,1,false),(43506,2,false),(43507,3,false),(43508,4,false),(43509,5,false),(43510,6,false),(43511,7,false),(43512,8,false),(43513,9,false),(43600,0,false),(43601,1,false),(43602,2,false),(43603,3,false),(43604,4,false),(43605,5,false),(43606,6,false),(43607,7,false),(43608,8,false),(43609,9,false),(44016,0,false),(44017,1,false),(44018,2,false),(44019,3,false),(44020,4,false),(44021,5,false),(44022,6,false),(44023,7,false),(44024,8,false),(44025,9,false),(65296,0,false),(65297,1,false),(65298,2,false),(65299,3,false),(65300,4,false),(65301,5,false),(65302,6,false),(65303,7,false),(65304,8,false),(65305,9,false),(66720,0,false),(66721,1,false),(66722,2,false),(66723,3,false),(66724,4,false),(66725,5,false),(66726,6,false),(66727,7,false),(66728,8,false),(66729,9,false),(68912,0,false),(68913,1,false),(68914,2,false),(68915,3,false),(68916,4,false),(68917,5,false),(68918,6,false),(68919,7,false),(68920,8,false),(68921,9,false),(69734,0,false),(69735,1,false),(69736,2,false),(69737,3,false),(69738,4,false),(69739,5,false),(69740,6,false),(69741,7,false),(69742,8,false),(69743,9,false),(69872,0,false),(69873,1,false),(69874,2,false),(69875,3,false),(69876,4,false),(69877,5,false),(69878,6,false),(69879,7,false),(69880,8,false),(69881,9,false),(69942,0,false),(69943,1,false),(69944,2,false),(69945,3,false),(69946,4,false),(69947,5,false),(69948,6,false),(69949,7,false),(69950,8,false),(69951,9,false),(70096,0,false),(70097,1,false),(70098,2,false),(70099,3,false),(70100,4,false),(70101,5,false),(70102,6,false),(70103,7,false),(70104,8,false),(70105,9,false),(70384,0,false),(70385,1,false),(70386,2,false),(70387,3,false),(70388,4,false),(70389,5,false),(70390,6,false),(70391,7,false),(70392,8,false),(70393,9,false),(70736,0,false),(70737,1,false),(70738,2,false),(70739,3,false),(70740,4,false),(70741,5,false),(70742,6,false),(70743,7,false),(70744,8,false),(70745,9,false),(70864,0,false),(70865,1,false),(70866,2,false),(70867,3,false),(70868,4,false),(70869,5,false),(70870,6,false),(70871,7,false),(70872,8,false),(70873,9,false),(71248,0,false),(71249,1,false),(71250,2,false),(71251,3,false),(71252,4,false),(71253,5,false),(71254,6,false),(71255,7,false),(71256,8,false),(71257,9,false),(71360,0,false),(71361,1,false),(71362,2,false),(71363,3,false),(71364,4,false),(71365,5,false),(71366,6,false),(71367,7,false),(71368,8,false),(71369,9,false),(71472,0,false),(71473,1,false),(71474,2,false),(71475,3,false),(71476,4,false),(71477,5,false),(71478,6,false),(71479,7,false),(71480,8,false),(71481,9,false),(71904,0,false),(71905,1,false),(71906,2,false),(71907,3,false),(71908,4,false),(71909,5,false),(71910,6,false),(71911,7,false),(71912,8,false),(71913,9,false),(72016,0,false),(72017,1,false),(72018,2,false),(72019,3,false),(72020,4,false),(72021,5,false),(72022,6,false),(72023,7,false),(72024,8,false),(72025,9,false),(72784,0,false),(72785,1,false),(72786,2,false),(72787,3,false),(72788,4,false),(72789,5,false),(72790,6,false),(72791,7,false),(72792,8,false),(72793,9,false),(73040,0,false),(73041,1,false),(73042,2,false),(73043,3,false),(73044,4,false),(73045,5,false),(73046,6,false),(73047,7,false),(73048,8,false),(73049,9,false),(73120,0,false),(73121,1,false),(73122,2,false),(73123,3,false),(73124,4,false),(73125,5,false),(73126,6,false),(73127,7,false),(73128,8,false),(73129,9,false),(73552,0,false),(73553,1,false),(73554,2,false),(73555,3,false),(73556,4,false),(73557,5,false),(73558,6,false),(73559,7,false),(73560,8,false),(73561,9,false),(92768,0,false),(92769,1,false),(92770,2,false),(92771,3,false),(92772,4,false),(92773,5,false),(92774,6,false),(92775,7,false),(92776,8,false),(92777,9,false),(92864,0,false),(92865,1,false),(92866,2,false),(92867,3,false),(92868,4,false),(92869,5,false),(92870,6,false),(92871,7,false),(92872,8,false),(92873,9,false),(93008,0,false),(93009,1,false),(93010,2,false),(93011,3,false),(93012,4,false),(93013,5,false),(93014,6,false),(93015,7,false),(93016,8,false),(93017,9,false),(120782,0,false),(120783,1,false),(120784,2,false),(120785,3,false),(120786,4,false),(120787,5,false),(120788,6,false),(120789,7,false),(120790,8,false),(120791,9,false),(120792,0,false),(120793,1,false),(120794,2,false),(120795,3,false),(120796,4,false),(120797,5,false),(120798,6,false),(120799,7,false),(120800,8,false),(120801,9,false),(120802,0,false),(120803,1,false),(120804,2,false),(120805,3,false),(120806,4,false),(120807,5,false),(120808,6,false),(120809,7,false),(120810,8,false),(120811,9,false),(120812,0,false),(120813,1,false),(120814,2,false),(120815,3,false),(120816,4,false),(120817,5,false),(120818,6,false),(120819,7,false),(120820,8,false),(120821,9,false),(120822,0,false),(120823,1,false),(120824,2,false),(120825,3,false),(120826,4,false),(120827,5,false),(120828,6,false),(120829,7,false),(120830,8,false),(120831,9,false),(123200,0,false),(123201,1,false),(123202,2,false),(123203,3,false),(123204,4,false),(123205,5,false),(123206,6,false),(123207,7,false),(123208,8,false),(123209,9,false),(123632,0,false),(123633,1,false),(123634,2,false),(123635,3,false),(123636,4,false),(123637,5,false),(123638,6,false),(123639,7,false),(123640,8,false),(123641,9,false),(124144,0,false),(124145,1,false),(124146,2,false),(124147,3,false),(124148,4,false),(124149,5,false),(124150,6,false),(124151,7,false),(124152,8,false),(124153,9,false),(125264,0,false),(125265,1,false),(125266,2,false),(125267,3,false),(125268,4,false),(125269,5,false),(125270,6,false),(125271,7,false),(125272,8,false),(125273,9,false),(130032,0,false),(130033,1,false),(130034,2,false),(130035,3,false),(130036,4,false),(130037,5,false),(130038,6,false),(130039,7,false),(130040,8,false),(130041,9,false);
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
  identity:=pg_temp.sc_record_9_decode(to_json(row),row.extra,'{}');
  IF (born<>'' AND born=pg_temp.sc_python_str(pg_temp.sc_get(identity,'seat_id')))
   OR (born='' AND pg_temp.sc_python_int(pg_temp.sc_get(identity,'generation'))>=gen) THEN RETURN row.id; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('orgdb-agent-name'),hashtext(n));
 SELECT id INTO aid FROM orgtree.agents WHERE name=n AND tombstone AND state='deleted'
  AND lineage_born=born AND generation=gen ORDER BY id LIMIT 1;
 IF aid IS NOT NULL THEN RETURN aid; END IF;
 pack:=pg_temp.sc_record_10_encode(json_build_object('state','deleted','seat_id',born,'generation',gen));
 INSERT INTO orgtree.agents(name,ord,tombstone,"state","lineage_born","generation",extra)
 VALUES(n,NULL,true,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','state')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','lineage_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','generation'))::text::bigint,pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')))
 RETURNING id INTO aid;
 RETURN aid;
END $fn$;


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


CREATE FUNCTION pg_temp.sc_record_12_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'holder_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'holder_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'holder_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'holder_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'holder_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'holder_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'holder_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'holder_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_12_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_13_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'recheck_owner_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'recheck_owner_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'recheck_owner_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'recheck_owner_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'recheck_owner_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'recheck_owner_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'recheck_owner_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'recheck_owner_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_13_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_14_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'granted_by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'granted_by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'granted_by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'granted_by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'granted_by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'granted_by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'granted_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'granted_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_14_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_15_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'revoked_by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'revoked_by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'revoked_by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'revoked_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_15_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_11_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['reviewer','holder','recheck_owner','granted_by','at','state','note','answered_request','spent_at','spent_via','revoked_at','revoked_by','revoked_reason']::text[]);
 x:=pg_temp.sc_get(v,'reviewer');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'reviewer_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'reviewer_name',x);

 ELSE e:=pg_temp.sc_put(e,'reviewer',x); END IF; END IF;
x:=pg_temp.sc_get(v,'holder');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'holder_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'holder_is','"s"'::json); r:=pg_temp.sc_put(r,'holder_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'holder_is','"o"'::json);
  sub:=pg_temp.sc_record_12_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'holder',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'holder_is','"x"'::json); e:=pg_temp.sc_put(e,'holder',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'holder_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'recheck_owner');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'recheck_owner_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'recheck_owner_is','"s"'::json); r:=pg_temp.sc_put(r,'recheck_owner_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'recheck_owner_is','"o"'::json);
  sub:=pg_temp.sc_record_13_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'recheck_owner',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'recheck_owner_is','"x"'::json); e:=pg_temp.sc_put(e,'recheck_owner',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'recheck_owner_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'granted_by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'granted_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'granted_by_is','"s"'::json); r:=pg_temp.sc_put(r,'granted_by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'granted_by_is','"o"'::json);
  sub:=pg_temp.sc_record_14_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'granted_by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'granted_by_is','"x"'::json); e:=pg_temp.sc_put(e,'granted_by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'granted_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'state');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'state_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) AND pg_temp.sc_text(x)=ANY(ARRAY['granted','spent','revoked']) THEN r:=pg_temp.sc_put(r,'state',x);

 ELSE e:=pg_temp.sc_put(e,'state',x); END IF; END IF;
x:=pg_temp.sc_get(v,'note');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'note_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'note',x);

 ELSE e:=pg_temp.sc_put(e,'note',x); END IF; END IF;
x:=pg_temp.sc_get(v,'answered_request');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'answered_request_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'answered_request',x);

 ELSE e:=pg_temp.sc_put(e,'answered_request',x); END IF; END IF;
x:=pg_temp.sc_get(v,'spent_at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'spent_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'spent_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'spent_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'spent_at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'spent_via');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'spent_via_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'spent_via',x);

 ELSE e:=pg_temp.sc_put(e,'spent_via',x); END IF; END IF;
x:=pg_temp.sc_get(v,'revoked_at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'revoked_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'revoked_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'revoked_at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'revoked_by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'revoked_by_is','"s"'::json); r:=pg_temp.sc_put(r,'revoked_by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'revoked_by_is','"o"'::json);
  sub:=pg_temp.sc_record_15_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'revoked_by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'revoked_by_is','"x"'::json); e:=pg_temp.sc_put(e,'revoked_by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'revoked_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'revoked_reason');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_reason_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'revoked_reason',x);

 ELSE e:=pg_temp.sc_put(e,'revoked_reason',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_11_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'reviewer',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'reviewer','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'holder','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'holder',pg_temp.sc_nonnull(pg_temp.sc_get(r,'holder_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'holder',pg_temp.sc_record_12_decode(r,pg_temp.sc_get(e,'holder'),'{}'));
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'recheck_owner','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'recheck_owner',pg_temp.sc_nonnull(pg_temp.sc_get(r,'recheck_owner_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'recheck_owner',pg_temp.sc_record_13_decode(r,pg_temp.sc_get(e,'recheck_owner'),'{}'));
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'granted_by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'granted_by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'granted_by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'granted_by',pg_temp.sc_record_14_decode(r,pg_temp.sc_get(e,'granted_by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'at','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'state'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'state',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'state_null'))::text='true' THEN v:=pg_temp.sc_put(v,'state','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'note'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'note',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'note_null'))::text='true' THEN v:=pg_temp.sc_put(v,'note','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'answered_request'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'answered_request',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'answered_request_null'))::text='true' THEN v:=pg_temp.sc_put(v,'answered_request','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'spent_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'spent_at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'spent_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'spent_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'spent_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'spent_at','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'spent_via'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'spent_via',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'spent_via_null'))::text='true' THEN v:=pg_temp.sc_put(v,'spent_via','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'revoked_at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'revoked_at','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'revoked_by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'revoked_by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'revoked_by',pg_temp.sc_record_15_decode(r,pg_temp.sc_get(e,'revoked_by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_reason'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'revoked_reason',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_reason_null'))::text='true' THEN v:=pg_temp.sc_put(v,'revoked_reason','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_17_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'claimed_by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'claimed_by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'claimed_by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'claimed_by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'claimed_by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'claimed_by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'claimed_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'claimed_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_17_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_16_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['claimed_at','claimed_by','ref','note','verified','method','detail','resolved_oid','target','ref_as_of','fetched_at','observed_at']::text[]);
 x:=pg_temp.sc_get(v,'claimed_at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'claimed_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'claimed_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'claimed_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'claimed_at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'claimed_by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'claimed_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'claimed_by_is','"s"'::json); r:=pg_temp.sc_put(r,'claimed_by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'claimed_by_is','"o"'::json);
  sub:=pg_temp.sc_record_17_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'claimed_by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'claimed_by_is','"x"'::json); e:=pg_temp.sc_put(e,'claimed_by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'claimed_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'ref');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'ref_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'ref',x);

 ELSE e:=pg_temp.sc_put(e,'ref',x); END IF; END IF;
x:=pg_temp.sc_get(v,'note');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'note_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'note',x);

 ELSE e:=pg_temp.sc_put(e,'note',x); END IF; END IF;
x:=pg_temp.sc_get(v,'verified');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'verified_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'verified',x);

 ELSE e:=pg_temp.sc_put(e,'verified',x); END IF; END IF;
x:=pg_temp.sc_get(v,'method');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'method_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'method',x);

 ELSE e:=pg_temp.sc_put(e,'method',x); END IF; END IF;
x:=pg_temp.sc_get(v,'detail');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'detail_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'detail',x);

 ELSE e:=pg_temp.sc_put(e,'detail',x); END IF; END IF;
x:=pg_temp.sc_get(v,'resolved_oid');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'resolved_oid_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'resolved_oid',x);

 ELSE e:=pg_temp.sc_put(e,'resolved_oid',x); END IF; END IF;
x:=pg_temp.sc_get(v,'target');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'target_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'target',x);

 ELSE e:=pg_temp.sc_put(e,'target',x); END IF; END IF;
x:=pg_temp.sc_get(v,'ref_as_of');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'ref_as_of_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'ref_as_of',x);

 ELSE e:=pg_temp.sc_put(e,'ref_as_of',x); END IF; END IF;
x:=pg_temp.sc_get(v,'fetched_at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'fetched_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'fetched_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'fetched_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'fetched_at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'observed_at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'observed_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'observed_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'observed_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'observed_at',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_16_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'claimed_at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'claimed_at','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'claimed_by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'claimed_by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'claimed_by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'claimed_by',pg_temp.sc_record_17_decode(r,pg_temp.sc_get(e,'claimed_by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'ref'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'ref',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'ref_null'))::text='true' THEN v:=pg_temp.sc_put(v,'ref','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'note'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'note',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'note_null'))::text='true' THEN v:=pg_temp.sc_put(v,'note','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'verified'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'verified',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'verified_null'))::text='true' THEN v:=pg_temp.sc_put(v,'verified','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'method'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'method',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'method_null'))::text='true' THEN v:=pg_temp.sc_put(v,'method','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'detail'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'detail',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'detail_null'))::text='true' THEN v:=pg_temp.sc_put(v,'detail','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'resolved_oid'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'resolved_oid',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'resolved_oid_null'))::text='true' THEN v:=pg_temp.sc_put(v,'resolved_oid','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'target'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'target',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'target_null'))::text='true' THEN v:=pg_temp.sc_put(v,'target','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'ref_as_of'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'ref_as_of',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'ref_as_of_null'))::text='true' THEN v:=pg_temp.sc_put(v,'ref_as_of','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'fetched_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'fetched_at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'fetched_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'fetched_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'fetched_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'fetched_at','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'observed_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'observed_at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'observed_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'observed_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'observed_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'observed_at','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_19_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_19_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_18_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['to','at','by','revoked_at','note']::text[]);
 x:=pg_temp.sc_get(v,'to');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'recipient_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'recipient_name',x);

 ELSE e:=pg_temp.sc_put(e,'to',x); END IF; END IF;
x:=pg_temp.sc_get(v,'at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_is','"s"'::json); r:=pg_temp.sc_put(r,'by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'by_is','"o"'::json);
  sub:=pg_temp.sc_record_19_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'by_is','"x"'::json); e:=pg_temp.sc_put(e,'by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'revoked_at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'revoked_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'revoked_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'revoked_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'revoked_at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'note');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'note_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'note',x);

 ELSE e:=pg_temp.sc_put(e,'note',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_18_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'recipient_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'to',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'recipient_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'to','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'at','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_record_19_decode(r,pg_temp.sc_get(e,'by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'revoked_at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'revoked_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'revoked_at','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'note'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'note',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'note_null'))::text='true' THEN v:=pg_temp.sc_put(v,'note','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_item_core(v json) RETURNS json LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE seats json:=pg_temp.sc_get(v,'review_seats'); delivery json:=pg_temp.sc_get(v,'delivery');
BEGIN
 IF pg_temp.sc_list_shape(seats) IN ('n','l') THEN v:=pg_temp.sc_drop(v,ARRAY['review_seats']); END IF;
 IF json_typeof(delivery)='object' THEN v:=pg_temp.sc_put(v,'delivery',pg_temp.sc_drop(delivery,ARRAY['implemented','committed','pushed','deployed','in_build']::text[])); END IF;
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
   pack:=pg_temp.sc_record_11_encode(payload);
   holder:=pg_temp.sc_get(payload,'holder'); reviewer:=pg_temp.sc_get(payload,'reviewer');
   IF json_typeof(holder)='object' AND pg_temp.sc_canonical(reviewer)=pg_temp.sc_canonical(pg_temp.sc_get(holder,'node')) THEN reviewer:=holder; END IF;
   INSERT INTO orgtree."work_item_review_seats"("item_id","seq","reviewer_agent_id","holder_agent_id","recheck_owner_agent_id","reviewer_name","reviewer_name_null","holder_is","holder_kind","holder_name","holder_name_null","holder_generation","holder_generation_null","holder_born","holder_born_null","holder_deleted","holder_deleted_null","recheck_owner_is","recheck_owner_kind","recheck_owner_name","recheck_owner_name_null","recheck_owner_generation","recheck_owner_generation_null","recheck_owner_born","recheck_owner_born_null","recheck_owner_deleted","recheck_owner_deleted_null","granted_by_is","granted_by_kind","granted_by_name","granted_by_name_null","granted_by_generation","granted_by_generation_null","granted_by_born","granted_by_born_null","granted_by_deleted","granted_by_deleted_null","at","at_text","at_null","state","state_null","note","note_null","answered_request","answered_request_null","spent_at","spent_at_text","spent_at_null","spent_via","spent_via_null","revoked_at","revoked_at_text","revoked_at_null","revoked_by_is","revoked_by_kind","revoked_by_name","revoked_by_name_null","revoked_by_generation","revoked_by_generation_null","revoked_by_born","revoked_by_born_null","revoked_by_deleted","revoked_by_deleted_null","revoked_reason","revoked_reason_null","extra") VALUES(item,entry.ord-1,pg_temp.sc_current(reviewer),pg_temp.sc_current(holder),pg_temp.sc_current(pg_temp.sc_get(payload,'recheck_owner')),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_name_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_is')))::char(1),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_kind')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_name_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_generation'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_generation_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_born_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_deleted'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','holder_deleted_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_is')))::char(1),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_kind')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_name_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_generation'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_generation_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_born_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_deleted'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recheck_owner_deleted_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_is')))::char(1),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_kind')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_name_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_generation'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_generation_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_born_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_deleted'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','granted_by_deleted_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','state')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','state_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','note')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','note_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','answered_request'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','answered_request_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','spent_at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','spent_at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','spent_at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','spent_via')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','spent_via_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_is')))::char(1),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_kind')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_name_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_generation'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_generation_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_born_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_deleted'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_by_deleted_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_reason')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_reason_null'))::text::boolean,pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')));
  END LOOP;
 END IF;
 entries:=pg_temp.sc_get(v,'delivery');
 IF json_typeof(entries)='object' THEN
  FOR entry IN SELECT key FROM json_each((SELECT value FROM orgtree.docket_safe(entries))) WHERE key=ANY(ARRAY['implemented','committed','pushed','deployed','in_build']::text[]) LOOP
   payload:=pg_temp.sc_get(entries,entry.key);
   state:=CASE json_typeof(payload) WHEN 'null' THEN 'n' WHEN 'object' THEN 'o' ELSE 'x' END;
   pack:=pg_temp.sc_record_16_encode(CASE WHEN state='o' THEN payload ELSE '{}'::json END);
   IF state='x' THEN pack:=pg_temp.sc_put(pack,'extra',json_build_object('claim',payload)); END IF;
   INSERT INTO orgtree."work_item_delivery"("item_id","stage","claim_is","claimed_at","claimed_at_text","claimed_at_null","claimed_by_is","claimed_by_kind","claimed_by_name","claimed_by_name_null","claimed_by_generation","claimed_by_generation_null","claimed_by_born","claimed_by_born_null","claimed_by_deleted","claimed_by_deleted_null","ref","ref_null","note","note_null","verified","verified_null","method","method_null","detail","detail_null","resolved_oid","resolved_oid_null","target","target_null","ref_as_of","ref_as_of_null","fetched_at","fetched_at_text","fetched_at_null","observed_at","observed_at_text","observed_at_null","extra") VALUES(item,entry.key,state,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_is')))::char(1),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_kind')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_name_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_generation'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_generation_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_born_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_deleted'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','claimed_by_deleted_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','ref')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','ref_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','note')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','note_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','verified'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','verified_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','method')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','method_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','detail')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','detail_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','resolved_oid')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','resolved_oid_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','target')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','target_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','ref_as_of')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','ref_as_of_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','fetched_at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','fetched_at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','fetched_at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','observed_at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','observed_at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','observed_at_null'))::text::boolean,pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')));
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
  SELECT coalesce(json_agg(pg_temp.sc_record_11_decode(to_json(t),extra,'{}') ORDER BY seq),'[]'::json) INTO entries
   FROM orgtree.work_item_review_seats t WHERE item_id=item;
  v:=pg_temp.sc_put(v,'review_seats',entries);
 END IF;
 stages:=pg_temp.sc_get(v,'delivery');
 FOR row IN SELECT t.*,to_json(t) raw FROM orgtree.work_item_delivery t WHERE item_id=item LOOP
  value:=CASE row.claim_is WHEN 'n' THEN 'null'::json WHEN 'x' THEN pg_temp.sc_get(row.extra,'claim')
   ELSE pg_temp.sc_record_16_decode(row.raw,row.extra,'{}') END;
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
   payload:=orgtree.docket_field(entries,(entry.ord-1)::text); pack:=pg_temp.sc_record_18_encode(payload);
   INSERT INTO orgtree."work_item_artifact_grants"("item_id","artifact_id","pos","agent_id","recipient_name","recipient_name_null","at","at_text","at_null","by_is","by_kind","by_name","by_name_null","by_generation","by_generation_null","by_born","by_born_null","by_deleted","by_deleted_null","revoked_at","revoked_at_text","revoked_at_null","note","note_null","extra") VALUES(item,artifact,entry.ord-1,pg_temp.sc_current(pg_temp.sc_get(payload,'to')),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recipient_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','recipient_name_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_is')))::char(1),pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_kind')))::text,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_name')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_name_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_generation'))::text::bigint,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_generation_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_born')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_born_null'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_deleted'))::text::boolean,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_deleted_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_at')))::timestamptz,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_at_text')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','revoked_at_null'))::text::boolean,pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','note')))::text,pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','note_null'))::text::boolean,pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')));
  END LOOP;
 END IF;
END $fn$;
CREATE FUNCTION pg_temp.sc_restore_grants(v json,artifact bigint) RETURNS json LANGUAGE plpgsql AS $fn$
DECLARE state text; entries json;
BEGIN
 SELECT grants_is INTO state FROM orgtree.work_item_artifacts WHERE id=artifact;
 IF state='n' THEN RETURN pg_temp.sc_put(v,'grants','null'); END IF;
 IF state='l' THEN
  SELECT coalesce(json_agg(pg_temp.sc_record_18_decode(to_json(t),extra,'{}') ORDER BY pos),'[]'::json) INTO entries
   FROM orgtree.work_item_artifact_grants t WHERE artifact_id=artifact;
  RETURN pg_temp.sc_put(v,'grants',entries);
 END IF;
 RETURN v;
END $fn$;


CREATE FUNCTION pg_temp.sc_record_21_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'node',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'owner_node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'owner_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'born',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'owner_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_21_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_22_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'node',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'reviewer_node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'reviewer_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'born',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'reviewer_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_22_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_20_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['manual_attention','accepted','owner','reviewer','delivery','review_seats']::text[]);
 x:=pg_temp.sc_get(v,'manual_attention');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'manual_attention_null','true'::json);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'manual_attention',x);

 ELSE e:=pg_temp.sc_put(e,'manual_attention',x); END IF; END IF;
x:=pg_temp.sc_get(v,'accepted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_null','true'::json);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'accepted',x);

 ELSE e:=pg_temp.sc_put(e,'accepted',x); END IF; END IF;
x:=pg_temp.sc_get(v,'owner');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'owner_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'owner_is','"o"'::json);
  sub:=pg_temp.sc_record_21_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'owner',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'owner_is','"x"'::json); e:=pg_temp.sc_put(e,'owner',x); END IF; END IF;
x:=pg_temp.sc_get(v,'reviewer');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'reviewer_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'reviewer_is','"o"'::json);
  sub:=pg_temp.sc_record_22_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'reviewer',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'reviewer_is','"x"'::json); e:=pg_temp.sc_put(e,'reviewer',x); END IF; END IF;
x:=pg_temp.sc_get(v,'delivery');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'delivery_null','true'::json);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'delivery',x);

 ELSE e:=pg_temp.sc_put(e,'delivery',x); END IF; END IF;
x:=pg_temp.sc_get(v,'review_seats');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'review_seats',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'review_seats',x);

 ELSE e:=pg_temp.sc_put(e,'review_seats',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_20_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'manual_attention'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'manual_attention',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'manual_attention_null'))::text='true' THEN v:=pg_temp.sc_put(v,'manual_attention','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'accepted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'accepted','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'owner','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'owner',pg_temp.sc_record_21_decode(r,pg_temp.sc_get(e,'owner'),children)); END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'reviewer','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'reviewer',pg_temp.sc_record_22_decode(r,pg_temp.sc_get(e,'reviewer'),children)); END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'delivery'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'delivery',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'delivery_null'))::text='true' THEN v:=pg_temp.sc_put(v,'delivery','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'review_seats'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'review_seats',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_25_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'attention_by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'attention_by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'attention_by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'attention_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_25_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_24_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['reason','at','by','set_rev']::text[]);
 x:=pg_temp.sc_get(v,'reason');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_reason_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'attention_reason',x);

 ELSE e:=pg_temp.sc_put(e,'reason',x); END IF; END IF;
x:=pg_temp.sc_get(v,'at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'attention_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'attention_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'attention_by_is','"s"'::json); r:=pg_temp.sc_put(r,'attention_by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'attention_by_is','"o"'::json);
  sub:=pg_temp.sc_record_25_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'attention_by_is','"x"'::json); e:=pg_temp.sc_put(e,'by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'attention_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'set_rev');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_set_rev_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'attention_set_rev',x);

 ELSE e:=pg_temp.sc_put(e,'set_rev',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_24_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_reason'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'reason',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_reason_null'))::text='true' THEN v:=pg_temp.sc_put(v,'reason','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'at','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_record_25_decode(r,pg_temp.sc_get(e,'by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_set_rev'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'set_rev',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_set_rev_null'))::text='true' THEN v:=pg_temp.sc_put(v,'set_rev','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_27_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'accepted_by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'accepted_by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'accepted_by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'accepted_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_27_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_28_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['unclassified','total','summary']::text[]);
 x:=pg_temp.sc_get(v,'unclassified');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_unclassified_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_unclassified',x);

 ELSE e:=pg_temp.sc_put(e,'unclassified',x); END IF; END IF;
x:=pg_temp.sc_get(v,'total');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_total_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_total',x);

 ELSE e:=pg_temp.sc_put(e,'total',x); END IF; END IF;
x:=pg_temp.sc_get(v,'summary');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_summary_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_summary',x);

 ELSE e:=pg_temp.sc_put(e,'summary',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_28_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_unclassified'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'unclassified',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_unclassified_null'))::text='true' THEN v:=pg_temp.sc_put(v,'unclassified','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_total'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'total',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_total_null'))::text='true' THEN v:=pg_temp.sc_put(v,'total','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_summary'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'summary',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_summary_null'))::text='true' THEN v:=pg_temp.sc_put(v,'summary','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_26_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['at','by','note','via','evidence_gap']::text[]);
 x:=pg_temp.sc_get(v,'at');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_at_null','true'::json);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'accepted_at',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'accepted_at_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'at',x); END IF; END IF;
x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'accepted_by_is','"s"'::json); r:=pg_temp.sc_put(r,'accepted_by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'accepted_by_is','"o"'::json);
  sub:=pg_temp.sc_record_27_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'accepted_by_is','"x"'::json); e:=pg_temp.sc_put(e,'by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'accepted_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'note');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_note_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'accepted_note',x);

 ELSE e:=pg_temp.sc_put(e,'note',x); END IF; END IF;
x:=pg_temp.sc_get(v,'via');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_via_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'accepted_via',x);

 ELSE e:=pg_temp.sc_put(e,'via',x); END IF; END IF;
x:=pg_temp.sc_get(v,'evidence_gap');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'accepted_evidence_gap_is','"o"'::json);
  sub:=pg_temp.sc_record_28_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'evidence_gap',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'accepted_evidence_gap_is','"x"'::json); e:=pg_temp.sc_put(e,'evidence_gap',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_26_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_at'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'at',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_at_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_at')))));
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_at_null'))::text='true' THEN v:=pg_temp.sc_put(v,'at','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_record_27_decode(r,pg_temp.sc_get(e,'by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_note'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'note',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_note_null'))::text='true' THEN v:=pg_temp.sc_put(v,'note','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_via'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'via',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_via_null'))::text='true' THEN v:=pg_temp.sc_put(v,'via','null');
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_evidence_gap_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'evidence_gap','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'evidence_gap',pg_temp.sc_record_28_decode(r,pg_temp.sc_get(e,'evidence_gap'),children)); END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_29_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'node',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'owner_node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'owner_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'born',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'owner_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'owner_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'owner_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_29_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_30_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'node',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'reviewer_node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'reviewer_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'born',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'reviewer_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'reviewer_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'reviewer_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_30_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_31_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY[]::text[]);

 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_31_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN

 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_23_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['manual_attention','accepted','owner','reviewer','delivery']::text[]);
 x:=pg_temp.sc_get(v,'manual_attention');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'attention_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'attention_is','"o"'::json);
  sub:=pg_temp.sc_record_24_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'manual_attention',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'attention_is','"x"'::json); e:=pg_temp.sc_put(e,'manual_attention',x); END IF; END IF;
x:=pg_temp.sc_get(v,'accepted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'accepted_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'accepted_is','"o"'::json);
  sub:=pg_temp.sc_record_26_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'accepted',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'accepted_is','"x"'::json); e:=pg_temp.sc_put(e,'accepted',x); END IF; END IF;
x:=pg_temp.sc_get(v,'owner');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'owner_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'owner_is','"o"'::json);
  sub:=pg_temp.sc_record_29_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'owner',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'owner_is','"x"'::json); e:=pg_temp.sc_put(e,'owner',x); END IF; END IF;
x:=pg_temp.sc_get(v,'reviewer');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'reviewer_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'reviewer_is','"o"'::json);
  sub:=pg_temp.sc_record_30_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'reviewer',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'reviewer_is','"x"'::json); e:=pg_temp.sc_put(e,'reviewer',x); END IF; END IF;
x:=pg_temp.sc_get(v,'delivery');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'delivery_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'delivery_is','"o"'::json);
  sub:=pg_temp.sc_record_31_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'delivery',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'delivery_is','"x"'::json); e:=pg_temp.sc_put(e,'delivery',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_23_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'attention_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'manual_attention','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'manual_attention',pg_temp.sc_record_24_decode(r,pg_temp.sc_get(e,'manual_attention'),children)); END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'accepted_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'accepted','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'accepted',pg_temp.sc_record_26_decode(r,pg_temp.sc_get(e,'accepted'),children)); END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'owner_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'owner','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'owner',pg_temp.sc_record_29_decode(r,pg_temp.sc_get(e,'owner'),children)); END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'reviewer_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'reviewer','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'reviewer',pg_temp.sc_record_30_decode(r,pg_temp.sc_get(e,'reviewer'),children)); END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'delivery_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'delivery','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'delivery',pg_temp.sc_record_31_decode(r,pg_temp.sc_get(e,'delivery'),children)); END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_32_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['grants']::text[]);
 x:=pg_temp.sc_get(v,'grants');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'grants',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'grants',x);

 ELSE e:=pg_temp.sc_put(e,'grants',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_32_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'grants'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'grants',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_33_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY[]::text[]);

 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_33_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN

 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_34_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','from','by','derived']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'node',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'born',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'from');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'from',x);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'from',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'from_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'from',x); END IF; END IF;
x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'by',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'by',x);

 ELSE e:=pg_temp.sc_put(e,'by',x); END IF; END IF;
x:=pg_temp.sc_get(v,'derived');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'derived',x);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'derived',x);

 ELSE e:=pg_temp.sc_put(e,'derived',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_34_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'from'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'from',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'from_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'from')))));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'by',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'derived'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'derived',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_36_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_36_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_35_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','from','by','derived','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'node',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'generation',x);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'born',x);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'from');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'from',x);
 ELSIF pg_temp.sc_fits('ts',x) THEN r:=pg_temp.sc_put(r,'from',to_json(pg_temp.sc_timestamp(x)));
 IF pg_temp.sc_text(pg_temp.sc_ts_json(x)) IS DISTINCT FROM pg_temp.sc_text(x) THEN r:=pg_temp.sc_put(r,'from_text',x); END IF;
 ELSE e:=pg_temp.sc_put(e,'from',x); END IF; END IF;
x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_is','"s"'::json); r:=pg_temp.sc_put(r,'by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'by_is','"o"'::json);
  sub:=pg_temp.sc_record_36_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'by_is','"x"'::json); e:=pg_temp.sc_put(e,'by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'derived');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'derived',x);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'derived',x);

 ELSE e:=pg_temp.sc_put(e,'derived',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_35_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'from'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'from',coalesce(pg_temp.sc_nonnull(pg_temp.sc_get(r,'from_text')),pg_temp.sc_ts_json(pg_temp.sc_nonnull(pg_temp.sc_get(r,'from')))));
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_record_36_decode(r,pg_temp.sc_get(e,'by'),'{}'));
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'derived'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'derived',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_38_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['by','raised_by','next_actor']::text[]);
 x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'by',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'history_by',x);

 ELSE e:=pg_temp.sc_put(e,'by',x); END IF; END IF;
x:=pg_temp.sc_get(v,'raised_by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'raised_by',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'history_raised_by',x);

 ELSE e:=pg_temp.sc_put(e,'raised_by',x); END IF; END IF;
x:=pg_temp.sc_get(v,'next_actor');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN e:=pg_temp.sc_put(e,'next_actor',x);
 ELSIF pg_temp.sc_fits('json',x) THEN r:=pg_temp.sc_put(r,'history_next_actor',x);

 ELSE e:=pg_temp.sc_put(e,'next_actor',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_38_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_by'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'by',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'raised_by',x);
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'next_actor',x);
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_37_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['history']::text[]);
 x:=pg_temp.sc_get(v,'history');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'history_is','"o"'::json);
  sub:=pg_temp.sc_record_38_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'history',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'history_is','"x"'::json); e:=pg_temp.sc_put(e,'history',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_37_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'history','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'history',pg_temp.sc_record_38_decode(r,pg_temp.sc_get(e,'history'),children)); END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_41_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_node_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_node',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'history_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_41_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_node'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_node_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_42_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_raised_by_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_raised_by_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_raised_by_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'history_raised_by_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_raised_by_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_raised_by_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_raised_by_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'history_raised_by_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_42_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_43_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['node','generation','born','deleted']::text[]);
 x:=pg_temp.sc_get(v,'node');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_next_actor_name_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_next_actor_name',x);

 ELSE e:=pg_temp.sc_put(e,'node',x); END IF; END IF;
x:=pg_temp.sc_get(v,'generation');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_next_actor_generation_null','true'::json);
 ELSIF pg_temp.sc_fits('int',x) THEN r:=pg_temp.sc_put(r,'history_next_actor_generation',x);

 ELSE e:=pg_temp.sc_put(e,'generation',x); END IF; END IF;
x:=pg_temp.sc_get(v,'born');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_next_actor_born_null','true'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_next_actor_born',x);

 ELSE e:=pg_temp.sc_put(e,'born',x); END IF; END IF;
x:=pg_temp.sc_get(v,'deleted');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_next_actor_deleted_null','true'::json);
 ELSIF pg_temp.sc_fits('bool',x) THEN r:=pg_temp.sc_put(r,'history_next_actor_deleted',x);

 ELSE e:=pg_temp.sc_put(e,'deleted',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_43_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_name'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'node',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_name_null'))::text='true' THEN v:=pg_temp.sc_put(v,'node','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_generation'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'generation',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_generation_null'))::text='true' THEN v:=pg_temp.sc_put(v,'generation','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_born'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'born',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_born_null'))::text='true' THEN v:=pg_temp.sc_put(v,'born','null');
END IF;
x:=pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_deleted'));
IF x IS NOT NULL AND json_typeof(x)<>'null' THEN
 v:=pg_temp.sc_put(v,'deleted',x);
ELSIF pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_deleted_null'))::text='true' THEN v:=pg_temp.sc_put(v,'deleted','null');
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_40_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['by','raised_by','next_actor']::text[]);
 x:=pg_temp.sc_get(v,'by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_by_is','"s"'::json); r:=pg_temp.sc_put(r,'by_node',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'history_by_is','"o"'::json);
  sub:=pg_temp.sc_record_41_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'history_by_is','"x"'::json); e:=pg_temp.sc_put(e,'by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_node')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'history_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'raised_by');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_raised_by_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_raised_by_is','"s"'::json); r:=pg_temp.sc_put(r,'history_raised_by_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'history_raised_by_is','"o"'::json);
  sub:=pg_temp.sc_record_42_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'raised_by',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'history_raised_by_is','"x"'::json); e:=pg_temp.sc_put(e,'raised_by',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'history_raised_by_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
x:=pg_temp.sc_get(v,'next_actor');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_next_actor_is','"n"'::json);
 ELSIF pg_temp.sc_fits('text',x) THEN r:=pg_temp.sc_put(r,'history_next_actor_is','"s"'::json); r:=pg_temp.sc_put(r,'history_next_actor_name',x);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'history_next_actor_is','"o"'::json);
  sub:=pg_temp.sc_record_43_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'next_actor',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'history_next_actor_is','"x"'::json); e:=pg_temp.sc_put(e,'next_actor',x); END IF;
 n:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_name')));
 IF n IS NOT NULL THEN r:=pg_temp.sc_put(r,'history_next_actor_kind',to_json(CASE WHEN n='user' THEN 'user' WHEN n='orgtree' THEN 'engine' WHEN n LIKE '@org:%' OR n LIKE '@net:%' THEN 'outside' ELSE 'agent' END)); END IF;
END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_40_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'by_node')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'by',pg_temp.sc_record_41_decode(r,pg_temp.sc_get(e,'by'),'{}'));
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'raised_by','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'raised_by',pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_raised_by_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'raised_by',pg_temp.sc_record_42_decode(r,pg_temp.sc_get(e,'raised_by'),'{}'));
END IF;
shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'next_actor','null');
ELSIF shape='s' THEN v:=pg_temp.sc_put(v,'next_actor',pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_next_actor_name')));
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'next_actor',pg_temp.sc_record_43_decode(r,pg_temp.sc_get(e,'next_actor'),'{}'));
END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;


CREATE FUNCTION pg_temp.sc_record_39_encode(v json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE r json:='{}'; e json; children json:='{}'; x json; sub json; vals json;
 shape text; n text; entry record;
BEGIN
 IF json_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'migration record is not an object'; END IF;
 e:=pg_temp.sc_drop(v,ARRAY['history']::text[]);
 x:=pg_temp.sc_get(v,'history');
IF x IS NOT NULL THEN
 IF json_typeof(x)='null' THEN r:=pg_temp.sc_put(r,'history_is','"n"'::json);
 ELSIF json_typeof(x)='object' THEN r:=pg_temp.sc_put(r,'history_is','"o"'::json);
  sub:=pg_temp.sc_record_40_encode(x); r:=pg_temp.sc_merge(r,pg_temp.sc_get(sub,'row')); children:=pg_temp.sc_merge(children,pg_temp.sc_get(sub,'children'));
  IF json_typeof(pg_temp.sc_get(sub,'extra'))='object' THEN e:=pg_temp.sc_put(e,'history',pg_temp.sc_get(sub,'extra')); END IF;
 ELSE r:=pg_temp.sc_put(r,'history_is','"x"'::json); e:=pg_temp.sc_put(e,'history',x); END IF; END IF;
 RETURN json_build_object('row',r,'extra',CASE WHEN e::text='{}' THEN NULL ELSE e END,'children',children);
END
$fn$;
CREATE FUNCTION pg_temp.sc_record_39_decode(r json,e json,children json) RETURNS json
LANGUAGE plpgsql AS $fn$
DECLARE v json:='{}'; x json; sub json; vals json; shape text; entry record;
BEGIN
 shape:=pg_temp.sc_text(pg_temp.sc_nonnull(pg_temp.sc_get(r,'history_is')));
IF shape='n' THEN v:=pg_temp.sc_put(v,'history','null');
ELSIF shape='o' THEN v:=pg_temp.sc_put(v,'history',pg_temp.sc_record_40_decode(r,pg_temp.sc_get(e,'history'),children)); END IF;
 RETURN pg_temp.sc_overlay(v,e);
END
$fn$;

-- Authored with tools/schema_conformance_sql.py; edit the generator.
-- Alpha databases migrate in place. No legacy reconversion is used.
SET LOCAL timezone='UTC';
LOCK TABLE orgtree.agents IN EXCLUSIVE MODE;

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

ALTER TABLE orgtree.agents DROP CONSTRAINT agents_state_enum;
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_state_enum CHECK(state IN ('live','archived','unrecoverable','deleted'));
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_cost_is" char(1);
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_cost_kind" char(1);
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_cost_integer" numeric;
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_cost_float" double precision;
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_cost_compensation" double precision;
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_toks_is" char(1);
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_toks_kind" char(1);
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_toks_integer" numeric;
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_toks_float" double precision;
ALTER TABLE orgtree."agents" ADD COLUMN IF NOT EXISTS "turn_est_toks_compensation" double precision;

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."agents" t WHERE true
  ORDER BY t."id" LOOP
  raw:=old.raw;
  original:=pg_temp.sc_record_1_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');

  pack:=pg_temp.sc_record_2_encode(original);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_2_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'agents before write');
  UPDATE orgtree."agents" t SET "turn_est_cost_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_cost_is')))::char(1),
 "turn_est_cost_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_cost_kind')))::char(1),
 "turn_est_cost_integer"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_cost_integer'))::text::numeric,
 "turn_est_cost_float"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_cost_float'))::text::double precision,
 "turn_est_cost_compensation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_cost_compensation'))::text::double precision,
 "turn_est_toks_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_toks_is')))::char(1),
 "turn_est_toks_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_toks_kind')))::char(1),
 "turn_est_toks_integer"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_toks_integer'))::text::numeric,
 "turn_est_toks_float"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_toks_float'))::text::double precision,
 "turn_est_toks_compensation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','turn_est_toks_compensation'))::text::double precision,
 "state"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','state')))::text,
 extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."id"=old."id";

  SELECT to_json(t) INTO changed FROM orgtree."agents" t WHERE t."id"=old."id";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_2_decode(changed,pg_temp.sc_get(changed,'extra'),children),
                            'agents after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."agents" DROP COLUMN "turn_est_cost";
ALTER TABLE orgtree."agents" DROP COLUMN "turn_est_toks";
ALTER TABLE orgtree."agents" ADD CONSTRAINT "agents_turn_est_cost_is_enum" CHECK("turn_est_cost_is" IN ('n','l','x'));
ALTER TABLE orgtree."agents" ADD CONSTRAINT "agents_turn_est_toks_is_enum" CHECK("turn_est_toks_is" IN ('n','l','x'));
ALTER TABLE orgtree."agents" ADD CONSTRAINT "agents_turn_est_cost_kind_enum" CHECK("turn_est_cost_kind" IN ('i','f'));
ALTER TABLE orgtree."agents" ADD CONSTRAINT "agents_turn_est_toks_kind_enum" CHECK("turn_est_toks_kind" IN ('i','f'));
ALTER TABLE orgtree."lifecycle_events" RENAME COLUMN "current_candidate" TO "sc_old_current_candidate";
ALTER TABLE orgtree."lifecycle_events" ADD COLUMN IF NOT EXISTS "current_candidate" text;

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."lifecycle_events" t WHERE true
  ORDER BY t."id" LOOP
  raw:=old.raw; raw:=pg_temp.sc_put(raw,'current_candidate',pg_temp.sc_get(raw,'sc_old_current_candidate'));
  original:=pg_temp.sc_record_3_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');

  pack:=pg_temp.sc_record_4_encode(original);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_4_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'lifecycle_events before write');
  UPDATE orgtree."lifecycle_events" t SET "current_candidate"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','current_candidate')))::text,
 "current_candidate_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','current_candidate_null'))::text::boolean,
 extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."id"=old."id";

  SELECT to_json(t) INTO changed FROM orgtree."lifecycle_events" t WHERE t."id"=old."id";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_4_decode(changed,pg_temp.sc_get(changed,'extra'),children),
                            'lifecycle_events after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."lifecycle_events" DROP COLUMN "sc_old_current_candidate";
ALTER TABLE orgtree.agent_turns ALTER COLUMN idx DROP NOT NULL;
ALTER TABLE orgtree.agent_turns ADD COLUMN recent_pos bigint;
ALTER TABLE orgtree.agent_turns ADD COLUMN row_version bigint NOT NULL DEFAULT 0;

CREATE TEMP TABLE sc_turn_sources ON COMMIT DROP AS
 SELECT id,agent_id,idx,
  pg_temp.sc_canonical(pg_temp.sc_record_5_decode(to_json(t),extra,'{}')) AS exact
 FROM orgtree.agent_turns t;
CREATE INDEX sc_turn_source_match ON sc_turn_sources(agent_id,md5(exact),idx DESC);
CREATE TEMP TABLE sc_recent_sources ON COMMIT DROP AS
 SELECT agent_id,pos,
  pg_temp.sc_canonical(pg_temp.sc_record_5_decode(to_json(t),extra,'{}')) AS exact
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
   INSERT INTO orgtree.agent_turns(agent_id,idx,recent_pos,"n","at","at_text","cost","ms","ms_null","toks","denials","approvals","ran_as","killed","estimated","cost_complete","cost_source","cost_unknown_fields","route","reported","model_usage_key",extra)
    SELECT old.agent_id,NULL,old.pos,old."n",old."at",old."at_text",old."cost",old."ms",old."ms_null",old."toks",old."denials",old."approvals",old."ran_as",old."killed",old."estimated",old."cost_complete",old."cost_source",old."cost_unknown_fields",old."route",old."reported",old."model_usage_key",old.extra;
  END IF;
  previous_agent:=old.agent_id;
 END LOOP;
 IF EXISTS (
  SELECT agent_id,recent_pos,pg_temp.sc_canonical(pg_temp.sc_record_5_decode(to_json(t),extra,'{}')) AS exact
   FROM orgtree.agent_turns t WHERE recent_pos IS NOT NULL
  EXCEPT SELECT agent_id,pos,exact FROM sc_recent_sources) OR EXISTS (
  SELECT agent_id,pos,exact FROM sc_recent_sources EXCEPT
  SELECT agent_id,recent_pos,pg_temp.sc_canonical(pg_temp.sc_record_5_decode(to_json(t),extra,'{}'))
   FROM orgtree.agent_turns t WHERE recent_pos IS NOT NULL) THEN
  RAISE EXCEPTION 'schema conformance changed recent turn occurrences';
 END IF;
 IF EXISTS (
  SELECT id,agent_id,idx,pg_temp.sc_canonical(pg_temp.sc_record_5_decode(to_json(t),extra,'{}')) AS exact
   FROM orgtree.agent_turns t WHERE idx IS NOT NULL EXCEPT SELECT * FROM sc_turn_sources)
 OR EXISTS (SELECT * FROM sc_turn_sources EXCEPT
  SELECT id,agent_id,idx,pg_temp.sc_canonical(pg_temp.sc_record_5_decode(to_json(t),extra,'{}'))
   FROM orgtree.agent_turns t WHERE idx IS NOT NULL) THEN
  RAISE EXCEPTION 'schema conformance changed retained log identities';
 END IF;
END
$membership$;
DROP TABLE orgtree.agent_recent_turns;
ALTER TABLE orgtree.agent_turns ADD CONSTRAINT agent_turn_membership CHECK(idx IS NOT NULL OR recent_pos IS NOT NULL);
ALTER TABLE orgtree.agent_turns ADD CONSTRAINT agent_turn_recent_nonnegative CHECK(recent_pos>=0);

CREATE TABLE orgtree.agent_turn_cost_unknown_fields (
  "turn_id" bigint NOT NULL,
  "pos" integer NOT NULL,
  "value" text,
  PRIMARY KEY ("turn_id", "pos"),
  FOREIGN KEY ("turn_id") REFERENCES orgtree.agent_turns ("id") ON DELETE CASCADE
);
CREATE TABLE orgtree.agent_turn_model_usage_keys (
  "turn_id" bigint NOT NULL,
  "pos" integer NOT NULL,
  "value" text,
  PRIMARY KEY ("turn_id", "pos"),
  FOREIGN KEY ("turn_id") REFERENCES orgtree.agent_turns ("id") ON DELETE CASCADE
);
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "cost_unknown_fields_is" char(1);
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "model_usage_key_is" char(1);
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "model_usage_asked" text;
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "model_usage_asked_null" boolean;
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "model_usage_matched" boolean;
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "model_usage_matched_null" boolean;
ALTER TABLE orgtree."agent_turns" ADD COLUMN IF NOT EXISTS "model_usage_keys_is" char(1);

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."agent_turns" t WHERE true
  ORDER BY t."id" LOOP
  raw:=old.raw;
  original:=pg_temp.sc_record_6_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');

  pack:=pg_temp.sc_record_7_encode(original);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_7_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'agent_turns before write');
  UPDATE orgtree."agent_turns" t SET "cost_unknown_fields_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','cost_unknown_fields_is')))::char(1),
 "model_usage_key_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','model_usage_key_is')))::char(1),
 "model_usage_asked"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','model_usage_asked')))::text,
 "model_usage_asked_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','model_usage_asked_null'))::text::boolean,
 "model_usage_matched"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','model_usage_matched'))::text::boolean,
 "model_usage_matched_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','model_usage_matched_null'))::text::boolean,
 "model_usage_keys_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','model_usage_keys_is')))::char(1),
 extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."id"=old."id";

 INSERT INTO orgtree.agent_turn_cost_unknown_fields(turn_id,pos,value)
 SELECT old.id,ord-1,pg_temp.sc_text(value)
 FROM json_array_elements(coalesce(orgtree.docket_field(pack,'children','agent_turn_cost_unknown_fields'),'[]'::json)) WITH ORDINALITY x(value,ord);
 SELECT coalesce(json_agg(value ORDER BY pos),'[]'::json) INTO raw FROM orgtree.agent_turn_cost_unknown_fields WHERE turn_id=old.id;
 children:=pg_temp.sc_put(children,'agent_turn_cost_unknown_fields',raw);


 INSERT INTO orgtree.agent_turn_model_usage_keys(turn_id,pos,value)
 SELECT old.id,ord-1,pg_temp.sc_text(value)
 FROM json_array_elements(coalesce(orgtree.docket_field(pack,'children','agent_turn_model_usage_keys'),'[]'::json)) WITH ORDINALITY x(value,ord);
 SELECT coalesce(json_agg(value ORDER BY pos),'[]'::json) INTO raw FROM orgtree.agent_turn_model_usage_keys WHERE turn_id=old.id;
 children:=pg_temp.sc_put(children,'agent_turn_model_usage_keys',raw);

  SELECT to_json(t) INTO changed FROM orgtree."agent_turns" t WHERE t."id"=old."id";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_7_decode(changed,pg_temp.sc_get(changed,'extra'),children),
                            'agent_turns after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."agent_turns" DROP COLUMN "cost_unknown_fields";
ALTER TABLE orgtree."agent_turns" DROP COLUMN "model_usage_key";
ALTER TABLE orgtree."agent_turns" ADD CONSTRAINT "agent_turns_cost_unknown_fields_is_enum" CHECK("cost_unknown_fields_is" IN ('n','l','x'));
ALTER TABLE orgtree."agent_turns" ADD CONSTRAINT "agent_turns_model_usage_key_is_enum" CHECK("model_usage_key_is" IN ('n','o','l','x'));
ALTER TABLE orgtree."agent_turns" ADD CONSTRAINT "agent_turns_model_usage_keys_is_enum" CHECK("model_usage_keys_is" IN ('n','l','x'));
CREATE UNIQUE INDEX agent_turns_recent_position ON orgtree.agent_turns (agent_id,recent_pos) WHERE recent_pos IS NOT NULL;
CREATE INDEX agent_turns_recent_tail ON orgtree.agent_turns (agent_id,recent_pos DESC,id) WHERE recent_pos IS NOT NULL;
CREATE INDEX agent_turns_log_tail ON orgtree.agent_turns (agent_id,idx DESC,id) WHERE idx IS NOT NULL;
CREATE INDEX agent_turns_log_number ON orgtree.agent_turns (agent_id,n,idx DESC,id) WHERE idx IS NOT NULL;
CREATE INDEX agent_turns_log_at ON orgtree.agent_turns(agent_id,at DESC,id DESC) WHERE idx IS NOT NULL;
CREATE INDEX agents_current_tombstone ON orgtree.agents(name,lineage_born,generation,id) WHERE tombstone AND state='deleted';
ALTER TABLE orgtree.work_items ADD COLUMN review_seats_is char(1) CHECK(review_seats_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN owner_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE;
ALTER TABLE orgtree.work_items ADD COLUMN reviewer_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE;
ALTER TABLE orgtree.work_item_holders ADD COLUMN agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE;
ALTER TABLE orgtree.work_item_artifacts ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE orgtree.work_item_artifacts ADD COLUMN grants_is char(1) CHECK(grants_is IN ('n','l','x'));
ALTER TABLE orgtree.work_item_artifacts ADD CONSTRAINT work_item_artifact_id UNIQUE(id);
ALTER TABLE orgtree.work_item_artifacts ADD CONSTRAINT work_item_artifact_row_id UNIQUE(item_id,id);
CREATE TABLE orgtree.work_item_delivery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES orgtree.work_items(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('implemented','committed','pushed','deployed','in_build')),
  claim_is char(1) NOT NULL CHECK (claim_is IN ('n','o','x')),
  row_version bigint NOT NULL DEFAULT 0,
  "claimed_at" timestamptz,
  "claimed_at_text" text,
  "claimed_at_null" boolean,
  "claimed_by_is" char(1),
  "claimed_by_kind" text,
  "claimed_by_name" text,
  "claimed_by_name_null" boolean,
  "claimed_by_generation" bigint,
  "claimed_by_generation_null" boolean,
  "claimed_by_born" text,
  "claimed_by_born_null" boolean,
  "claimed_by_deleted" boolean,
  "claimed_by_deleted_null" boolean,
  "ref" text,
  "ref_null" boolean,
  "note" text,
  "note_null" boolean,
  "verified" boolean,
  "verified_null" boolean,
  "method" text,
  "method_null" boolean,
  "detail" text,
  "detail_null" boolean,
  "resolved_oid" text,
  "resolved_oid_null" boolean,
  "target" text,
  "target_null" boolean,
  "ref_as_of" text,
  "ref_as_of_null" boolean,
  "fetched_at" timestamptz,
  "fetched_at_text" text,
  "fetched_at_null" boolean,
  "observed_at" timestamptz,
  "observed_at_text" text,
  "observed_at_null" boolean,
  "extra" json
);
CREATE UNIQUE INDEX work_item_delivery_stage ON orgtree.work_item_delivery(item_id,stage);
ALTER TABLE orgtree.work_item_delivery ADD CONSTRAINT "work_item_delivery_claimed_by_is_enum" CHECK("claimed_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree.work_item_delivery ADD CONSTRAINT "work_item_delivery_claimed_by_kind_enum" CHECK("claimed_by_kind" IN ('agent','user','engine','outside'));
CREATE TABLE orgtree.work_item_review_seats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES orgtree.work_items(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  reviewer_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE,
  holder_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE,
  recheck_owner_agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE,
  row_version bigint NOT NULL DEFAULT 0,
  "reviewer_name" text,
  "reviewer_name_null" boolean,
  "holder_is" char(1),
  "holder_kind" text,
  "holder_name" text,
  "holder_name_null" boolean,
  "holder_generation" bigint,
  "holder_generation_null" boolean,
  "holder_born" text,
  "holder_born_null" boolean,
  "holder_deleted" boolean,
  "holder_deleted_null" boolean,
  "recheck_owner_is" char(1),
  "recheck_owner_kind" text,
  "recheck_owner_name" text,
  "recheck_owner_name_null" boolean,
  "recheck_owner_generation" bigint,
  "recheck_owner_generation_null" boolean,
  "recheck_owner_born" text,
  "recheck_owner_born_null" boolean,
  "recheck_owner_deleted" boolean,
  "recheck_owner_deleted_null" boolean,
  "granted_by_is" char(1),
  "granted_by_kind" text,
  "granted_by_name" text,
  "granted_by_name_null" boolean,
  "granted_by_generation" bigint,
  "granted_by_generation_null" boolean,
  "granted_by_born" text,
  "granted_by_born_null" boolean,
  "granted_by_deleted" boolean,
  "granted_by_deleted_null" boolean,
  "at" timestamptz,
  "at_text" text,
  "at_null" boolean,
  "state" text,
  "state_null" boolean,
  "note" text,
  "note_null" boolean,
  "answered_request" bigint,
  "answered_request_null" boolean,
  "spent_at" timestamptz,
  "spent_at_text" text,
  "spent_at_null" boolean,
  "spent_via" text,
  "spent_via_null" boolean,
  "revoked_at" timestamptz,
  "revoked_at_text" text,
  "revoked_at_null" boolean,
  "revoked_by_is" char(1),
  "revoked_by_kind" text,
  "revoked_by_name" text,
  "revoked_by_name_null" boolean,
  "revoked_by_generation" bigint,
  "revoked_by_generation_null" boolean,
  "revoked_by_born" text,
  "revoked_by_born_null" boolean,
  "revoked_by_deleted" boolean,
  "revoked_by_deleted_null" boolean,
  "revoked_reason" text,
  "revoked_reason_null" boolean,
  "extra" json
);
CREATE UNIQUE INDEX work_item_review_seats_seq ON orgtree.work_item_review_seats(item_id,seq);
CREATE INDEX work_item_review_seats_reviewer ON orgtree.work_item_review_seats(reviewer_agent_id,item_id,seq);
CREATE INDEX work_item_review_seats_reviewer_name ON orgtree.work_item_review_seats(reviewer_name,item_id,seq DESC);
CREATE INDEX work_item_review_seats_holder ON orgtree.work_item_review_seats(holder_agent_id,item_id);
CREATE INDEX work_item_review_seats_recheck_owner ON orgtree.work_item_review_seats(recheck_owner_agent_id,item_id);
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_holder_is_enum" CHECK("holder_is" IN ('n','o','s','x'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_recheck_owner_is_enum" CHECK("recheck_owner_is" IN ('n','o','s','x'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_granted_by_is_enum" CHECK("granted_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_revoked_by_is_enum" CHECK("revoked_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_state_enum" CHECK("state" IN ('granted','spent','revoked'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_holder_kind_enum" CHECK("holder_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_recheck_owner_kind_enum" CHECK("recheck_owner_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_granted_by_kind_enum" CHECK("granted_by_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree.work_item_review_seats ADD CONSTRAINT "work_item_review_seats_revoked_by_kind_enum" CHECK("revoked_by_kind" IN ('agent','user','engine','outside'));
CREATE TABLE orgtree.work_item_artifact_grants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL,
  artifact_id bigint NOT NULL,
  pos integer NOT NULL CHECK (pos >= 0),
  agent_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE,
  row_version bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (item_id,artifact_id) REFERENCES orgtree.work_item_artifacts(item_id,id) ON DELETE CASCADE NOT DEFERRABLE,
  "recipient_name" text,
  "recipient_name_null" boolean,
  "at" timestamptz,
  "at_text" text,
  "at_null" boolean,
  "by_is" char(1),
  "by_kind" text,
  "by_name" text,
  "by_name_null" boolean,
  "by_generation" bigint,
  "by_generation_null" boolean,
  "by_born" text,
  "by_born_null" boolean,
  "by_deleted" boolean,
  "by_deleted_null" boolean,
  "revoked_at" timestamptz,
  "revoked_at_text" text,
  "revoked_at_null" boolean,
  "note" text,
  "note_null" boolean,
  "extra" json
);
CREATE UNIQUE INDEX work_item_artifact_grants_pos ON orgtree.work_item_artifact_grants(artifact_id,pos);
CREATE INDEX work_item_artifact_grants_artifact ON orgtree.work_item_artifact_grants(artifact_id,item_id,pos);
CREATE INDEX work_item_artifact_grants_agent ON orgtree.work_item_artifact_grants(agent_id,item_id,artifact_id,pos DESC);
CREATE INDEX work_item_artifact_grants_name ON orgtree.work_item_artifact_grants(artifact_id,recipient_name,pos DESC);
CREATE INDEX work_item_artifact_grants_item ON orgtree.work_item_artifact_grants(item_id,artifact_id);
ALTER TABLE orgtree.work_item_artifact_grants ADD CONSTRAINT "work_item_artifact_grants_by_is_enum" CHECK("by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree.work_item_artifact_grants ADD CONSTRAINT "work_item_artifact_grants_by_kind_enum" CHECK("by_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_is" char(1);
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_reason" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_reason_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_at" timestamptz;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_at_text" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_at_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_is" char(1);
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_kind" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_name" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_name_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_generation" bigint;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_generation_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_born" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_born_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_deleted" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_by_deleted_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_set_rev" bigint;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "attention_set_rev_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_is" char(1);
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_at" timestamptz;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_at_text" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_at_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_is" char(1);
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_kind" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_name" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_name_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_generation" bigint;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_generation_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_born" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_born_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_deleted" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_by_deleted_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_note" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_note_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_via" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_via_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_is" char(1);
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_unclassified" bigint;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_unclassified_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_total" bigint;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_total_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_summary" text;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "accepted_evidence_gap_summary_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "owner_deleted" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "owner_deleted_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "reviewer_deleted" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "reviewer_deleted_null" boolean;
ALTER TABLE orgtree."work_items" ADD COLUMN IF NOT EXISTS "delivery_is" char(1);

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."work_items" t WHERE true
  ORDER BY t."id" LOOP
  raw:=old.raw;
  original:=pg_temp.sc_record_20_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');
  normalized:=pg_temp.sc_item_core(original);
  pack:=pg_temp.sc_record_23_encode(normalized);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(normalized,pg_temp.sc_record_23_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'work_items before write');
  UPDATE orgtree."work_items" t SET "attention_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_is')))::char(1),
 "attention_reason"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_reason')))::text,
 "attention_reason_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_reason_null'))::text::boolean,
 "attention_at"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_at')))::timestamptz,
 "attention_at_text"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_at_text')))::text,
 "attention_at_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_at_null'))::text::boolean,
 "attention_by_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_is')))::char(1),
 "attention_by_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_kind')))::text,
 "attention_by_name"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_name')))::text,
 "attention_by_name_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_name_null'))::text::boolean,
 "attention_by_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_generation'))::text::bigint,
 "attention_by_generation_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_generation_null'))::text::boolean,
 "attention_by_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_born')))::text,
 "attention_by_born_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_born_null'))::text::boolean,
 "attention_by_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_deleted'))::text::boolean,
 "attention_by_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_by_deleted_null'))::text::boolean,
 "attention_set_rev"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_set_rev'))::text::bigint,
 "attention_set_rev_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','attention_set_rev_null'))::text::boolean,
 "accepted_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_is')))::char(1),
 "accepted_at"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_at')))::timestamptz,
 "accepted_at_text"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_at_text')))::text,
 "accepted_at_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_at_null'))::text::boolean,
 "accepted_by_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_is')))::char(1),
 "accepted_by_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_kind')))::text,
 "accepted_by_name"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_name')))::text,
 "accepted_by_name_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_name_null'))::text::boolean,
 "accepted_by_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_generation'))::text::bigint,
 "accepted_by_generation_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_generation_null'))::text::boolean,
 "accepted_by_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_born')))::text,
 "accepted_by_born_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_born_null'))::text::boolean,
 "accepted_by_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_deleted'))::text::boolean,
 "accepted_by_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_by_deleted_null'))::text::boolean,
 "accepted_note"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_note')))::text,
 "accepted_note_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_note_null'))::text::boolean,
 "accepted_via"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_via')))::text,
 "accepted_via_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_via_null'))::text::boolean,
 "accepted_evidence_gap_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_is')))::char(1),
 "accepted_evidence_gap_unclassified"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_unclassified'))::text::bigint,
 "accepted_evidence_gap_unclassified_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_unclassified_null'))::text::boolean,
 "accepted_evidence_gap_total"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_total'))::text::bigint,
 "accepted_evidence_gap_total_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_total_null'))::text::boolean,
 "accepted_evidence_gap_summary"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_summary')))::text,
 "accepted_evidence_gap_summary_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','accepted_evidence_gap_summary_null'))::text::boolean,
 "owner_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','owner_is')))::char(1),
 "owner_node"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','owner_node')))::text,
 "owner_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','owner_generation'))::text::bigint,
 "owner_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','owner_born')))::text,
 "owner_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','owner_deleted'))::text::boolean,
 "owner_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','owner_deleted_null'))::text::boolean,
 "reviewer_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_is')))::char(1),
 "reviewer_node"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_node')))::text,
 "reviewer_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_generation'))::text::bigint,
 "reviewer_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_born')))::text,
 "reviewer_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_deleted'))::text::boolean,
 "reviewer_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','reviewer_deleted_null'))::text::boolean,
 "delivery_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','delivery_is')))::char(1),
 extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."id"=old."id";
  PERFORM pg_temp.sc_item_relations(original,old.id); UPDATE orgtree.work_items SET owner_agent_id=pg_temp.sc_current(pg_temp.sc_get(original,'owner')),reviewer_agent_id=pg_temp.sc_current(pg_temp.sc_get(original,'reviewer')) WHERE id=old.id;
  SELECT to_json(t) INTO changed FROM orgtree."work_items" t WHERE t."id"=old."id";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_restore_item(pg_temp.sc_record_23_decode(changed,pg_temp.sc_get(changed,'extra'),children),old.id),
                            'work_items after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."work_items" DROP COLUMN "accepted";
ALTER TABLE orgtree."work_items" DROP COLUMN "accepted_null";
ALTER TABLE orgtree."work_items" DROP COLUMN "delivery";
ALTER TABLE orgtree."work_items" DROP COLUMN "delivery_null";
ALTER TABLE orgtree."work_items" DROP COLUMN "manual_attention";
ALTER TABLE orgtree."work_items" DROP COLUMN "manual_attention_null";
ALTER TABLE orgtree."work_items" DROP COLUMN "review_seats";
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_attention_is_enum" CHECK("attention_is" IN ('n','o','x'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_attention_by_is_enum" CHECK("attention_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_accepted_is_enum" CHECK("accepted_is" IN ('n','o','x'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_accepted_by_is_enum" CHECK("accepted_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_accepted_evidence_gap_is_enum" CHECK("accepted_evidence_gap_is" IN ('n','o','x'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_delivery_is_enum" CHECK("delivery_is" IN ('n','o','x'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_attention_by_kind_enum" CHECK("attention_by_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree."work_items" ADD CONSTRAINT "work_items_accepted_by_kind_enum" CHECK("accepted_by_kind" IN ('agent','user','engine','outside'));

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."work_item_artifacts" t WHERE true
  ORDER BY t."item_id",t."pos" LOOP
  raw:=old.raw;
  original:=pg_temp.sc_record_32_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');
  normalized:=pg_temp.sc_grant_core(original);
  pack:=pg_temp.sc_record_33_encode(normalized);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(normalized,pg_temp.sc_record_33_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'work_item_artifacts before write');
  UPDATE orgtree."work_item_artifacts" t SET extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."item_id"=old."item_id" AND t."pos"=old."pos";
  PERFORM pg_temp.sc_grant_relations(original,old.item_id,old.id);
  SELECT to_json(t) INTO changed FROM orgtree."work_item_artifacts" t WHERE t."item_id"=old."item_id" AND t."pos"=old."pos";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_restore_grants(pg_temp.sc_record_33_decode(changed,pg_temp.sc_get(changed,'extra'),children),old.id),
                            'work_item_artifacts after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."work_item_artifacts" DROP COLUMN "grants";
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_is" char(1);
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_kind" text;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_name" text;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_name_null" boolean;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_generation" bigint;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_generation_null" boolean;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_born" text;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_born_null" boolean;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_deleted" boolean;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "by_deleted_null" boolean;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "deleted" boolean;
ALTER TABLE orgtree."work_item_holders" ADD COLUMN IF NOT EXISTS "deleted_null" boolean;

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."work_item_holders" t WHERE true
  ORDER BY t."item_id",t."pos" LOOP
  raw:=old.raw;
  original:=pg_temp.sc_record_34_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');

  pack:=pg_temp.sc_record_35_encode(original);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_35_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'work_item_holders before write');
  UPDATE orgtree."work_item_holders" t SET "node"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','node')))::text,
 "generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','generation'))::text::bigint,
 "born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','born')))::text,
 "from"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','from')))::timestamptz,
 "from_text"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','from_text')))::text,
 "by_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_is')))::char(1),
 "by_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_kind')))::text,
 "by_name"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_name')))::text,
 "by_name_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_name_null'))::text::boolean,
 "by_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_generation'))::text::bigint,
 "by_generation_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_generation_null'))::text::boolean,
 "by_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_born')))::text,
 "by_born_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_born_null'))::text::boolean,
 "by_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_deleted'))::text::boolean,
 "by_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_deleted_null'))::text::boolean,
 "derived"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','derived'))::text::boolean,
 "deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','deleted'))::text::boolean,
 "deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','deleted_null'))::text::boolean,
 extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."item_id"=old."item_id" AND t."pos"=old."pos";
  UPDATE orgtree.work_item_holders SET agent_id=pg_temp.sc_current(original) WHERE item_id=old.item_id AND pos=old.pos;
  SELECT to_json(t) INTO changed FROM orgtree."work_item_holders" t WHERE t."item_id"=old."item_id" AND t."pos"=old."pos";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_35_decode(changed,pg_temp.sc_get(changed,'extra'),children),
                            'work_item_holders after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."work_item_holders" DROP COLUMN "by";
ALTER TABLE orgtree."work_item_holders" ADD CONSTRAINT "work_item_holders_by_is_enum" CHECK("by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree."work_item_holders" ADD CONSTRAINT "work_item_holders_by_kind_enum" CHECK("by_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_by_is" char(1);
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_by_kind" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "by_node" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "by_node_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "by_generation" bigint;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "by_generation_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "by_born" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "by_born_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_by_deleted" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_by_deleted_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_is" char(1);
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_kind" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_name" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_name_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_generation" bigint;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_generation_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_born" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_born_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_deleted" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_raised_by_deleted_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_is" char(1);
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_kind" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_name" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_name_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_generation" bigint;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_generation_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_born" text;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_born_null" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_deleted" boolean;
ALTER TABLE orgtree."work_item_events" ADD COLUMN IF NOT EXISTS "history_next_actor_deleted_null" boolean;

DO $backfill$
DECLARE old record; raw json; original json; normalized json; pack json; changed json; children json;
BEGIN
 FOR old IN SELECT t.*,to_json(t) AS raw FROM orgtree."work_item_events" t WHERE source='history'
  ORDER BY t."id" LOOP
  raw:=old.raw;
  original:=pg_temp.sc_record_37_decode(raw,pg_temp.sc_get(raw,'extra'),'{}');

  pack:=pg_temp.sc_record_39_encode(original);
  children:=pg_temp.sc_get(pack,'children');
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_39_decode(pg_temp.sc_get(pack,'row'),pg_temp.sc_get(pack,'extra'),children),
                            'work_item_events before write');
  UPDATE orgtree."work_item_events" t SET "history_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_is')))::char(1),
 "history_by_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_by_is')))::char(1),
 "history_by_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_by_kind')))::text,
 "by_node"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_node')))::text,
 "by_node_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_node_null'))::text::boolean,
 "by_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_generation'))::text::bigint,
 "by_generation_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_generation_null'))::text::boolean,
 "by_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_born')))::text,
 "by_born_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','by_born_null'))::text::boolean,
 "history_by_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_by_deleted'))::text::boolean,
 "history_by_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_by_deleted_null'))::text::boolean,
 "history_raised_by_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_is')))::char(1),
 "history_raised_by_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_kind')))::text,
 "history_raised_by_name"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_name')))::text,
 "history_raised_by_name_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_name_null'))::text::boolean,
 "history_raised_by_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_generation'))::text::bigint,
 "history_raised_by_generation_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_generation_null'))::text::boolean,
 "history_raised_by_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_born')))::text,
 "history_raised_by_born_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_born_null'))::text::boolean,
 "history_raised_by_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_deleted'))::text::boolean,
 "history_raised_by_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_raised_by_deleted_null'))::text::boolean,
 "history_next_actor_is"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_is')))::char(1),
 "history_next_actor_kind"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_kind')))::text,
 "history_next_actor_name"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_name')))::text,
 "history_next_actor_name_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_name_null'))::text::boolean,
 "history_next_actor_generation"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_generation'))::text::bigint,
 "history_next_actor_generation_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_generation_null'))::text::boolean,
 "history_next_actor_born"=pg_temp.sc_text(pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_born')))::text,
 "history_next_actor_born_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_born_null'))::text::boolean,
 "history_next_actor_deleted"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_deleted'))::text::boolean,
 "history_next_actor_deleted_null"=pg_temp.sc_nonnull(orgtree.docket_field(pack,'row','history_next_actor_deleted_null'))::text::boolean,
 extra=pg_temp.sc_nonnull(pg_temp.sc_get(pack,'extra')) WHERE t."id"=old."id";

  SELECT to_json(t) INTO changed FROM orgtree."work_item_events" t WHERE t."id"=old."id";
  PERFORM pg_temp.sc_assert(original,pg_temp.sc_record_39_decode(changed,pg_temp.sc_get(changed,'extra'),children),
                            'work_item_events after write');
 END LOOP;
END
$backfill$;

ALTER TABLE orgtree."work_item_events" DROP COLUMN "history_by";
ALTER TABLE orgtree."work_item_events" DROP COLUMN "history_next_actor";
ALTER TABLE orgtree."work_item_events" DROP COLUMN "history_raised_by";
ALTER TABLE orgtree."work_item_events" ADD CONSTRAINT "work_item_events_history_by_is_enum" CHECK("history_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree."work_item_events" ADD CONSTRAINT "work_item_events_history_raised_by_is_enum" CHECK("history_raised_by_is" IN ('n','o','s','x'));
ALTER TABLE orgtree."work_item_events" ADD CONSTRAINT "work_item_events_history_next_actor_is_enum" CHECK("history_next_actor_is" IN ('n','o','s','x'));
ALTER TABLE orgtree."work_item_events" ADD CONSTRAINT "work_item_events_history_by_kind_enum" CHECK("history_by_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree."work_item_events" ADD CONSTRAINT "work_item_events_history_raised_by_kind_enum" CHECK("history_raised_by_kind" IN ('agent','user','engine','outside'));
ALTER TABLE orgtree."work_item_events" ADD CONSTRAINT "work_item_events_history_next_actor_kind_enum" CHECK("history_next_actor_kind" IN ('agent','user','engine','outside'));
CREATE INDEX work_items_owner_agent ON orgtree.work_items(owner_agent_id,id);
CREATE INDEX work_items_reviewer_agent ON orgtree.work_items(reviewer_agent_id,id);
CREATE INDEX work_item_holders_agent ON orgtree.work_item_holders(agent_id,item_id,pos);

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
           WHERE tgenabled IN ('O','A') AND relname IN ('agents','lifecycle_events','agent_turns','work_items','work_item_artifacts','work_item_holders','work_item_events') ORDER BY relname LOOP
  EXECUTE format('UPDATE orgtree.%I SET extra=extra WHERE ctid=(SELECT ctid FROM orgtree.%I LIMIT 1)',
                 t.relname,t.relname);
 END LOOP;
END $resume_flush$;
