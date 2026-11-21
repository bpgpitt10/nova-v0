/**
 * The chip lab: around the green, Live Caddie shows the four chip options in place of the club
 * recommendation. On for everyone (Brian, 21 Nov). Turn it off in a browser with ?chipLab=off and back on
 * with ?chipLab=on; the choice is remembered in that browser.
 */
const KEY = 'looper.chipLab'

export const isChipLabEnabled = (): boolean => {
  try {
    const param = new URLSearchParams(window.location.search).get('chipLab')
    if (param === 'off') window.localStorage.setItem(KEY, 'off')
    if (param === 'on') window.localStorage.removeItem(KEY)
    return window.localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}
