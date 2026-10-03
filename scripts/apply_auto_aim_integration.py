from pathlib import Path


def patch_main() -> None:
    path = Path('src-tauri/src/main.rs')
    text = path.read_text(encoding='utf-8')
    if 'mod auto_aim;' not in text:
        marker = '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]\n\n'
        assert marker in text
        text = text.replace(marker, marker + 'mod auto_aim;\n\n', 1)
    if 'auto_aim::gspro_auto_aim_calibrate_tee' not in text:
        marker = '        .invoke_handler(tauri::generate_handler![\n'
        assert marker in text
        text = text.replace(
            marker,
            marker
            + '            auto_aim::gspro_auto_aim_calibrate_tee,\n'
            + '            auto_aim::gspro_auto_aim_target,\n',
            1,
        )
    path.write_text(text, encoding='utf-8')


def patch_live_caddie() -> None:
    path = Path('src/pages/LiveCaddiePage.tsx')
    text = path.read_text(encoding='utf-8')

    if "from '../lib/gsproAutoAim'" not in text:
        marker = "import type { SavedSession } from '../types'\n"
        assert marker in text
        auto_import = (
            "import {\n"
            "  calibrateGsproAutoAimTee,\n"
            "  clickGsproAutoAimTarget,\n"
            "  isGsproAutoAimDesktopAvailable,\n"
            "} from '../lib/gsproAutoAim'\n"
        )
        text = text.replace(marker, auto_import + marker, 1)

    course_import_prefix = text.split("from '../courseGeometry/courseCatalog'", 1)[0]
    if 'resolveCourseIdFromGsproName' not in course_import_prefix:
        marker = '  getCourseCatalogEntry,\n  GREYWOLF_COURSE_ID,\n'
        assert marker in text
        text = text.replace(
            marker,
            '  getCourseCatalogEntry,\n  GREYWOLF_COURSE_ID,\n  resolveCourseIdFromGsproName,\n',
            1,
        )

    if 'const [autoAimStatus' not in text:
        marker = '  const [armedClub, setArmedClub] = useState<string | null>(null)\n'
        assert marker in text
        text = text.replace(
            marker,
            marker
            + "  const [autoAimStatus, setAutoAimStatus] = useState<'idle' | 'preparing' | 'aiming' | 'pass' | 'error'>('idle')\n"
            + '  const [autoAimError, setAutoAimError] = useState<string | null>(null)\n'
            + '  const [autoAimVectorErrorYds, setAutoAimVectorErrorYds] = useState<number | null>(null)\n',
            1,
        )

    if 'const armWithAutoAim = async () =>' not in text:
        marker = '  const selectCourse = (nextCourseId: CourseId) => {\n'
        assert marker in text
        handler = """  const armWithAutoAim = async () => {
    if (!displayedClub) return
    setArmedClub(displayedClub)

    // Browser/Vercel stays display-only. Physical GSPro input is Windows/Tauri only.
    if (!isGsproAutoAimDesktopAvailable()) return

    if (!hole || !inspectedCandidate || courseId === UNSELECTED_COURSE_ID) {
      setAutoAimStatus('error')
      setAutoAimError('The current hole or modeled aim point is not ready.')
      return
    }
    if (!liveMatchesHole || !liveSnapshot) {
      setAutoAimStatus('error')
      setAutoAimError('GSPro live state does not match the selected Looper hole. No click was sent.')
      return
    }

    const observedCourseId = liveSnapshot.courseKey
      ? resolveCourseIdFromGsproName(liveSnapshot.courseKey)
      : null
    if (observedCourseId && observedCourseId !== courseId) {
      setAutoAimStatus('error')
      setAutoAimError(`GSPro reports ${liveSnapshot.courseKey}; Looper is set to ${selectedCourse?.name ?? courseId}. No click was sent.`)
      return
    }

    const physicalPin = liveSnapshot.pinLocalYds ?? pinEstimate ?? hole.markers.pin
    if (!physicalPin) {
      setAutoAimStatus('error')
      setAutoAimError('Looper does not have a usable pin coordinate for Auto Aim.')
      return
    }

    setAutoAimError(null)
    setAutoAimVectorErrorYds(null)
    try {
      if (nextShotNumber === 1) {
        if (hole.par == null) throw new Error('Hole par is unavailable for tee calibration.')
        setAutoAimStatus('preparing')
        const calibration = await calibrateGsproAutoAimTee({
          courseId,
          holeNumber,
          par: hole.par,
          teeX: ball[0],
          teeY: ball[1],
        })
        if (!calibration.ok) {
          throw new Error(calibration.stderr || calibration.stdout || 'GSPro tee calibration failed.')
        }
      }

      setAutoAimStatus('aiming')
      const result = await clickGsproAutoAimTarget({
        courseId,
        holeNumber,
        pinX: physicalPin[0],
        pinY: physicalPin[1],
        targetX: inspectedCandidate.aimPoint[0],
        targetY: inspectedCandidate.aimPoint[1],
      })
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || 'GSPro Auto Aim failed.')
      }
      setAutoAimVectorErrorYds(result.vectorErrorYds)
      setAutoAimStatus('pass')
    } catch (error) {
      setAutoAimStatus('error')
      setAutoAimError(error instanceof Error ? error.message : String(error))
    }
  }

"""
        text = text.replace(marker, handler + marker, 1)

    if "setAutoAimStatus('idle')" not in text.split('const armWithAutoAim', 1)[0]:
        marker = """  useEffect(() => {
    if (isGreenSurface) {
      setArmedClub(null)
      setInspectedAimOffset(null)
    }
  }, [isGreenSurface])
"""
        assert marker in text
        reset = marker + """
  useEffect(() => {
    setAutoAimStatus('idle')
    setAutoAimError(null)
    setAutoAimVectorErrorYds(null)
  }, [courseId, holeNumber, nextShotNumber])
"""
        text = text.replace(marker, reset, 1)

    if 'Auto Aim: {autoAimError}' not in text:
        marker = '        {evaluationError ? <div className="live-caddie-alert bad">Decision engine: {evaluationError}</div> : null}\n'
        assert marker in text
        text = text.replace(
            marker,
            marker + '        {autoAimError ? <div className="live-caddie-alert bad">Auto Aim: {autoAimError}</div> : null}\n',
            1,
        )

    old_button = """                  <button
                    type=\"button\"
                    className={`live-arm-recommendation${armedClub && armedClub === displayedClub ? ' armed' : ''}`}
                    disabled={!displayedClub}
                    onClick={() => displayedClub && setArmedClub(displayedClub)}
                  >
                    {armedClub && armedClub === displayedClub
                      ? `${displayedClub} ARMED FOR NEXT SHOT`
                      : displayedClub
                        ? `HITTING ${displayedClub} · TAP TO ARM`
                        : evaluationPending
                          ? 'CALCULATING RECOMMENDATION…'
                          : 'WAITING FOR RECOMMENDATION'}
                  </button>"""
    new_button = """                  <button
                    type=\"button\"
                    className={`live-arm-recommendation${armedClub && armedClub === displayedClub ? ' armed' : ''}`}
                    disabled={!displayedClub || autoAimStatus === 'preparing' || autoAimStatus === 'aiming'}
                    onClick={() => void armWithAutoAim()}
                  >
                    {autoAimStatus === 'preparing'
                      ? 'PREPARING AUTO AIM…'
                      : autoAimStatus === 'aiming'
                        ? 'SETTING GSPro AIM…'
                        : autoAimStatus === 'pass' && armedClub && armedClub === displayedClub
                          ? `${displayedClub} AIM SET${autoAimVectorErrorYds != null ? ` · ${autoAimVectorErrorYds.toFixed(1)} yd err` : ''}`
                          : armedClub && armedClub === displayedClub
                            ? `${displayedClub} ARMED FOR NEXT SHOT`
                            : displayedClub
                              ? `HITTING ${displayedClub} · TAP TO ARM`
                              : evaluationPending
                                ? 'CALCULATING RECOMMENDATION…'
                                : 'WAITING FOR RECOMMENDATION'}
                  </button>"""
    if old_button in text:
        text = text.replace(old_button, new_button, 1)
    elif 'onClick={() => void armWithAutoAim()}' not in text:
        raise AssertionError('Live Caddie arm button did not match expected source')

    path.write_text(text, encoding='utf-8')


patch_main()
patch_live_caddie()
print('Auto Aim integration patch applied.')
