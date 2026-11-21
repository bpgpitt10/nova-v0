/**
 * The chip lab is experimental: around the green, Live Caddie shows the four chip options in place of the
 * club recommendation only when this is on. Turn it on with ?chipLab=on (off with ?chipLab=off); it's
 * remembered in this browser.
 */
const KEY = 'looper.chipLab'

export const isChipLabEnabled = (): boolean => {
  try {
    const param = new URLSearchParams(window.location.search).get('chipLab')
    if (param === 'on') window.localStorage.setItem(KEY, 'on')
    if (param === 'off') window.localStorage.removeItem(KEY)
    return window.localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}
