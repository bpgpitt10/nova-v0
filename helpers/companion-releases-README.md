# Looper Companion

The Looper Companion is a small Windows app that runs on your GSPro PC next to GSPro. It reads your shots and course files so [The Looper](https://thelooper.golf) can caddie for you live and keep every round. It sends nothing anywhere except to the Looper page open in your browser on the same network.

## Install

1. Download `LooperCompanionSetup.exe` from the [latest release](../../releases/latest).
2. Run it. There is nothing to choose and no administrator prompt.
3. The companion starts in the background and starts with Windows from then on. Open [thelooper.golf](https://thelooper.golf) on the same PC; it connects on its own.

Windows may show "Windows protected your PC" the first time (the app isn't code-signed yet). Choose **More info → Run anyway**.

If it ever stops, start it again from the Start menu (Looper Companion). To remove it, use Windows Settings → Apps → Looper Companion → Uninstall.

## Updating

Looper tells you on its home page when a newer companion is available. Download the new installer and run it; it replaces the old one.

`latest.json` in this repository is what the Looper site reads to know the newest release. This repository holds builds only; the source lives in a private repository.
