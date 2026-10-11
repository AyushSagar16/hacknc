-- Why a turn spoke (or stayed silent), for the console and the unprompted cap.
--   trigger:    named | reply_to_atlas | answers_question | question | booked | move_on | objection |
--               change_of_mind | trip_page | gate | gate_fallback | proactive | nudge | small_talk | off_topic | quiet
--   prompted:   someone needed Atlas (named it, answered its question, asked the room): never counted
--               against the unprompted-per-hour cap
--   silent_why: when the turn sent nothing visible, the reason
ALTER TABLE turns ADD COLUMN IF NOT EXISTS trigger text;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS prompted boolean;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS silent_why text;
