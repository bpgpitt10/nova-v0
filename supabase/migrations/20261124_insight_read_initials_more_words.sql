-- More three-letter words kept off the leaderboard (Brian, 24 Nov 2026, after "POO").
-- NOT VALID: rows already on the board stay; only new rows are checked. Applied to production 24 Nov.
-- Keep in step with NOT_INITIALS in src/pages/insightsReadStore.ts.
alter table public.insight_read_leaderboard drop constraint insight_read_leaderboard_initials_check;
alter table public.insight_read_leaderboard add constraint insight_read_leaderboard_initials_check
  check (initials ~ '^[A-Z]{1,3}$' and initials !~ '^(ASS|ARS|AZZ|FUK|FUC|FCK|FUX|FKU|FKN|KKK|NIG|NGR|NGA|FAG|FGT|CUM|JIZ|TIT|DIK|DIC|COK|COC|CNT|VAG|ANL|POO|PEE|PIS|SEX|XXX|WTF|STFU|KYS|NAZ|HOE|SUK|SUC)$')
  not valid;
