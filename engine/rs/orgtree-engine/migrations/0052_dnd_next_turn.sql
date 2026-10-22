-- An idle target can arm exactly its next admitted turn. This is separate
-- from agent_dnd: the opening mail must still wake and enter that turn.
ALTER TABLE ot.agents ADD COLUMN dnd_next_turn boolean NOT NULL DEFAULT false;
