# Looper Auth + Cloud Persistence

## Current direction

Looper uses Supabase for account identity and structured cloud persistence while keeping simulator-local filesystem permissions and training captures on the local device.

### Cloud data
- invite-only allowed users
- user profiles
- bag configuration
- saved sessions
- structured shot rows
- diagnostic metadata

### Never stored in Supabase
- screenshots
- minimap images
- heatmap captures
- base64 image payloads
- local GSPro filesystem handles

The database includes a constraint that rejects common image-payload keys from diagnostic event metadata.

## Authentication

The web client is wired to the Looper Supabase project with a browser-safe publishable key. Supabase environment variables may override the checked-in public project configuration later.

Planned/implemented login options:
- Google OAuth
- passwordless email magic link

Access remains invite-only after authentication. A successfully authenticated email must also have an enabled row in `public.allowed_users`.

## First-user / admin model

The initial owner account is stored as an enabled admin in `allowed_users`.

Admins may manage the allow list through `/admin/users`. Row Level Security allows an admin to list, add, enable, or disable invited users without exposing a service-role key to the browser.

## Persistence migration behavior

Existing local Looper data is treated conservatively during migration:

1. localStorage remains intact as the safety copy;
2. on the first allowed sign-in on a device, existing saved sessions and bag configuration are uploaded;
3. Looper then downloads cloud sessions and merges them with local saved sessions;
4. local data wins when the same session ID exists in both places during the initial migration pass;
5. a successful one-time bootstrap marker prevents repeated full uploads;
6. ordinary future bag/session changes dual-write locally first and cloud second.

A failed cloud write must never erase or block the existing local copy.

## Screenshot / capture policy

### Normal user
A screenshot exists only long enough to support the current extraction. Captures should live in memory or a tiny rolling working set and be overwritten/deleted when the hole advances. No growing browser image archive.

### Development simulator
A device-local **Training Capture Mode** will retain useful screenshots and accompanying extractor metadata in a user-approved local folder. This is a device setting, not a cloud account role.

### Cloud telemetry
Only compact structured diagnostic metadata is uploaded, such as:
- course and hole
- extractor/model version
- success/failure result
- reason/fallback code
- confidence
- detected class counts / crop dimensions when useful

This gives Looper fleet-wide failure telemetry without accumulating image storage.

## Supabase hardening

- Row Level Security is enabled on all Looper public tables.
- helper `SECURITY DEFINER` functions live in a non-exposed `private` schema;
- the `citext` extension was moved out of `public`;
- RLS auth calls are evaluated once per statement for better query planning;
- foreign-key lookup indexes required by the advisor were added;
- Supabase Security Advisor currently reports no findings.

## Remaining setup before merge

1. Set Supabase Auth Site URL to the intended production Looper URL.
2. Add the Vercel preview branch pattern as an allowed redirect while testing.
3. Configure Google OAuth credentials in Supabase (or temporarily test email magic-link login first).
4. Exercise one allowed account and one non-allowed account in the Vercel preview.
5. Confirm the first allowed login migrates local sessions and bag without changing the existing Looper UI/data behavior.
6. Confirm `/admin/users` can add/disable a test invite.

Do not merge this branch into `web-gspro-clean` until those tests pass.
