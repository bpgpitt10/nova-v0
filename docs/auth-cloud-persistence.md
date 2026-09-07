# Looper auth, cloud persistence, and capture policy

## Goal

Make `thelooper.golf` easy to share with a small invite-only group while keeping the normal operating cost effectively zero and preserving Looper's ability to improve its GSPro visual extraction over time.

## Identity

Initial sign-in methods:

- Google OAuth
- Email magic link / one-time link for users who do not want a Google account
- No passwords in Looper

Authentication alone does not grant access. Every authenticated email must also have an enabled row in `allowed_users`. The database RLS policies enforce the same allow-list rule, so bypassing the UI does not expose another user's data.

Initial administration can be done directly in Supabase by adding or disabling an email in `allowed_users`. A tiny Looper admin screen can come later.

## Cloud-owned data

Supabase becomes canonical for:

- user identity/profile
- bag configuration
- sessions
- shots
- shot variants/preferences as they are migrated
- small diagnostic/extractor events

Every durable row is user-scoped. Row Level Security must prevent one user from reading or writing another user's data.

`localStorage` remains a temporary safety copy during migration, not the final source of truth.

## Device-owned data

The GSPro directory handle is a device/browser permission and must never be synced to Supabase. A user connects the simulator PC once and Chrome/Edge retains that permission locally.

Developer/training capture is also a device setting, not an account role. Logging into the same account on a phone or another computer must not make that device start retaining screenshots.

## Screenshot policy

### Normal users

Screenshots are working memory only.

- do not upload screenshots to Supabase
- do not put screenshots in Postgres JSON
- do not accumulate screenshots in browser storage
- prefer in-memory captures
- if a persistent working slot is technically required, keep only a tiny rolling set for the current hole and overwrite/delete it when the hole changes

Normal users may emit small diagnostic metadata such as extractor version, course/hole, result, confidence, detected classes, and failure reason. This lets us identify patterns without storing the image itself.

### Development simulator

A simulator PC can opt into **Training Capture Mode**. That setting is local to that device.

When enabled, Looper may write full capture bundles to a user-selected local folder using the same persistent browser filesystem-access approach used for GSPro.

Recommended bundle shape:

```
Looper Training Captures/
  YYYY-MM-DD/
    course/
      hole-01/
        tee.png
        working.png
        extraction.json
        diagnostics.json
```

This data is retained locally for extractor/model improvement and never counts against Supabase storage.

### User-reported bad reads

A later optional feature can expose **Report bad read**. The user would explicitly choose to share the current screenshot plus diagnostics. It should not be an automatic upload path.

## Migration strategy

1. Add Supabase Auth + allow-list gate.
2. Add user-scoped cloud tables and RLS.
3. Dual-write new sessions to Supabase while retaining the existing local copy as rollback protection.
4. Import the existing Looper history into the signed-in owner's account.
5. Validate cloud/local parity.
6. Make Supabase canonical and reduce localStorage to cache/offline safety where useful.

Do not mix this migration with scoring, Stock/Pure algorithm, mishit, or intelligence-model changes.

## Cost guardrails

Design for the Supabase Free plan and Vercel Hobby plan at the expected hobby scale.

- no cloud screenshot retention
- no unnecessary blob/object storage
- structured shot rows instead of repeated giant payloads where practical
- keep `open_golf_coach` JSON temporarily for migration fidelity, then narrow it once all required derived fields are explicit
- diagnostics are metadata, not images

## Branch safety

This work belongs on `auth-cloud-persistence`, based on the browser-native GSPro `web-gspro-clean` baseline. Do not alter Production until auth and cloud persistence are separately validated.
