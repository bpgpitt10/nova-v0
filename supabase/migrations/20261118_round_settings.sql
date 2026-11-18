-- What the player picked at Start a Round (GSPro course type, green and fairway
-- firmness, stimp, tees, pins), saved on the round. GSPro doesn't record these
-- anywhere Looper can read. Null on rounds played without Start a Round.
alter table public.live_course_rounds add column if not exists round_settings jsonb;
