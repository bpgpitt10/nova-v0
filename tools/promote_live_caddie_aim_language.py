from __future__ import annotations

import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/LiveCaddiePage.tsx"
SOURCE_REF = "origin/aim-descriptor-shot-frame-v1"


def git_show(path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{SOURCE_REF}:{path}"],
        cwd=ROOT,
        text=True,
    )


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label} match, found {count}")
    return text.replace(old, new, 1)


def main() -> None:
    # Bring over only the validated shot-frame descriptor implementation. Do not
    # merge the old validation branch wholesale because it also carries unrelated
    # course/green work that has since diverged from Live Caddie stability.
    for relative in (
        "src/liveCaddie/aimDescriptor.ts",
        "src/liveCaddie/aimDescriptorCore.ts",
        "src/liveCaddie/aimDescriptorFrame.ts",
    ):
        destination = ROOT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(git_show(relative), encoding="utf-8")

    text = PAGE.read_text(encoding="utf-8")

    import_anchor = """import type {\n  AimCandidateEvaluation,\n  ClubAimEvaluation,\n} from '../liveCaddie/aimOptimization'\n"""
    import_replacement = import_anchor + """import {\n  buildAimContextSentence,\n  buildAimDescriptor,\n} from '../liveCaddie/aimDescriptor'\n"""
    if "buildAimDescriptor" not in text:
        text = replace_once(text, import_anchor, import_replacement, "aim descriptor import")

    state_anchor = """  const viewedClubRank = viewedEvaluation?.decisionRank ?? null\n"""
    state_replacement = state_anchor + """\n  const aimDescriptor = hole && viewedEvaluation && inspectedCandidate\n    ? buildAimDescriptor({\n        hole,\n        ball,\n        target: viewedEvaluation.planningTarget,\n        aimPoint: inspectedCandidate.aimPoint,\n        aimOffsetYds: inspectedCandidate.aimOffsetYds,\n        pin: pinEstimate,\n      })\n    : null\n  const playerFacingAim = aimDescriptor?.text\n    ?? (viewedEvaluation ? aimLabel(inspectedCandidate?.aimOffsetYds) : 'No modeled line')\n  const aimContext = aimDescriptor ? buildAimContextSentence(aimDescriptor) : null\n"""
    if "const playerFacingAim =" not in text:
        text = replace_once(text, state_anchor, state_replacement, "player-facing aim state")

    text = text.replace(
        "{viewedEvaluation ? aimLabel(inspectedCandidate?.aimOffsetYds) : 'No modeled line'}",
        "{playerFacingAim}",
        1,
    )

    map_old = """? `${displayedClub} · ${viewedEvaluation ? aimLabel(inspectedCandidate?.aimOffsetYds) : 'no modeled line'}`"""
    map_new = """? `${displayedClub} · ${viewedEvaluation ? playerFacingAim : 'no modeled line'}`"""
    text = replace_once(text, map_old, map_new, "shot-map aim heading")

    reason_old = """                    {inspectedCandidate?.decisionReason\n                      ?? viewedEvaluation?.decisionReason\n                      ?? (evaluationPending\n                        ? 'Looper is calculating the club, aim and next-shot value in the background.'\n                        : displayedClub\n                          ? `Looper does not yet have enough modeled support to rank a ${displayedClub} line for this shot.`\n                          : 'Looper is waiting for enough player data to rank this shot.')}\n"""
    reason_new = """                    {aimContext\n                      ?? inspectedCandidate?.decisionReason\n                      ?? viewedEvaluation?.decisionReason\n                      ?? (evaluationPending\n                        ? 'Looper is calculating the club, aim and next-shot value in the background.'\n                        : displayedClub\n                          ? `Looper does not yet have enough modeled support to rank a ${displayedClub} line for this shot.`\n                          : 'Looper is waiting for enough player data to rank this shot.')}\n"""
    if "{aimContext\n                      ?? inspectedCandidate?.decisionReason" not in text:
        text = replace_once(text, reason_old, reason_new, "aim context reason")

    PAGE.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
