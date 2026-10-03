-- The legacy archive maximum is any positive Python integer, including values
-- held in extra because they exceed bigint. Its successor has the same domain.
-- version/nrows retain the legacy append door's exact compare-and-set tuple.
-- Writers maintain this row explicitly, under its lock, never from a trigger.
CREATE TABLE orgtree.mailboxes (
 agent_id bigint PRIMARY KEY REFERENCES orgtree.agents(id) ON DELETE CASCADE,
 next_recv_seq numeric NOT NULL DEFAULT 1
   CHECK (next_recv_seq >= 1 AND next_recv_seq = trunc(next_recv_seq)),
 version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
 nrows bigint NOT NULL DEFAULT 0 CHECK (nrows >= 0)
);

-- Existing development databases get the same bound as a fresh conversion.
-- json rather than jsonb keeps values such as U+0000 in unrelated extra fields.
INSERT INTO orgtree.mailboxes(agent_id,next_recv_seq,nrows)
 SELECT agent_id,1+coalesce(max(CASE
   WHEN extra::json->'recv_seq' IS NOT NULL THEN CASE
     WHEN json_typeof(extra::json->'recv_seq')='number'
       AND extra::json->>'recv_seq' ~ '^[1-9][0-9]*$'
     THEN (extra::json->>'recv_seq')::numeric ELSE 0 END
   ELSE greatest(coalesce(recv_seq,0),0) END),0),count(*)
 FROM orgtree.mail_log GROUP BY agent_id;
