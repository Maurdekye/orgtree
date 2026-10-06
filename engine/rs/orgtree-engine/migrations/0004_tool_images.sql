-- Images a tool returned (a screenshot, a picture it read): the desk shows them
-- under the tool's chip. The writer keeps the newest few hundred per agent.
CREATE TABLE ot.tool_images (
  agent_id  bigint NOT NULL REFERENCES ot.agents (id),
  tool_id   text NOT NULL,
  idx       integer NOT NULL,
  media     text NOT NULL,
  data      bytea NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, tool_id, idx)
);
CREATE INDEX tool_images_age ON ot.tool_images (agent_id, at DESC);
