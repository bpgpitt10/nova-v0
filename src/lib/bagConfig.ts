export type Club =
  | 'Driver'
  | 'Mini Driver'
  | '2W'
  | '3W'
  | '4W'
  | '5W'
  | '7W'
  | '9W'
  | '2H'
  | '3H'
  | '4H'
  | '5H'
  | '6H'
  | '7H'
  | '1i'
  | '2i'
  | '3i'
  | '4i'
  | '5i'
  | '6i'
  | '7i'
  | '8i'
  | '9i'
  | 'PW'
  | 'AW'
  | 'GW'
  | 'SW'
  | 'LW'

export type ClubCategory = 'wood' | 'hybrid' | 'iron' | 'wedge'

export type BagClubConfig = {
  id: Club
  label: string
  category: ClubCategory
  active: boolean
  sortOrder: number
}

export type BagSetupSection = {
  title: string
  clubs: Club[]
}

export type PersistedBagConfig = {
  version: 1
  selectedClubs: Club[]
}

const BAG_CONFIG_STORAGE_KEY = 'nova-validation-bag-config'
export const BAG_CONFIG_UPDATED_EVENT = 'bag-config-updated'

const CLUB_ORDER: Club[] = [
  'Driver',
  'Mini Driver',
  '2W',
  '3W',
  '4W',
  '5W',
  '7W',
  '9W',
  '2H',
  '3H',
  '4H',
  '5H',
  '6H',
  '7H',
  '1i',
  '2i',
  '3i',
  '4i',
  '5i',
  '6i',
  '7i',
  '8i',
  '9i',
  'PW',
  'AW',
  'GW',
  'SW',
  'LW',
]

const CLUB_SET = new Set<Club>(CLUB_ORDER)

const LEGACY_DEFAULT_BAG: Club[] = [
  'Driver',
  '3W',
  '3H',
  '5i',
  '6i',
  '7i',
  '8i',
  '9i',
  'PW',
  'GW',
  'SW',
  'LW',
]

export const bagSetupSections: BagSetupSection[] = [
  { title: 'Driver', clubs: ['Driver', 'Mini Driver'] },
  { title: 'Fairway Woods', clubs: ['2W', '3W', '4W', '5W', '7W', '9W'] },
  { title: 'Hybrids', clubs: ['2H', '3H', '4H', '5H', '6H', '7H'] },
  { title: 'Utility / Driving Irons', clubs: ['1i', '2i'] },
  { title: 'Irons', clubs: ['3i', '4i', '5i', '6i', '7i', '8i', '9i', 'PW'] },
  { title: 'Wedges', clubs: ['AW', 'GW', 'SW', 'LW'] },
]

const isClub = (value: unknown): value is Club =>
  typeof value === 'string' && CLUB_SET.has(value as Club)

const uniqueClubIds = (clubs: Club[]) => Array.from(new Set(clubs))

export const sortClubIds = (clubs: Club[]) => {
  const order = new Map(CLUB_ORDER.map((club, index) => [club, index]))
  return [...uniqueClubIds(clubs)].sort(
    (left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER),
  )
}

export const loadBagConfig = (): PersistedBagConfig | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(BAG_CONFIG_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const selectedRaw = (parsed as { selectedClubs?: unknown }).selectedClubs
    if (!Array.isArray(selectedRaw)) {
      return null
    }
    const selectedClubs = sortClubIds(selectedRaw.filter(isClub))
    if (selectedClubs.length === 0) {
      return null
    }
    return {
      version: 1,
      selectedClubs,
    }
  } catch {
    return null
  }
}

export const saveBagConfig = (selectedClubs: Club[]) => {
  if (typeof window === 'undefined') {
    return
  }
  const payload: PersistedBagConfig = {
    version: 1,
    selectedClubs: sortClubIds(selectedClubs),
  }
  window.localStorage.setItem(BAG_CONFIG_STORAGE_KEY, JSON.stringify(payload))
  refreshBagConfigState()
  window.dispatchEvent(new Event(BAG_CONFIG_UPDATED_EVENT))
}

export const hasSavedBagConfig = () => loadBagConfig() !== null

export const getActiveBagClubIds = (): Club[] =>
  loadBagConfig()?.selectedClubs ?? LEGACY_DEFAULT_BAG

const buildCurrentBagConfig = (selectedClubs: Club[]): BagClubConfig[] => {
  const activeClubIdSet = new Set<Club>(selectedClubs)

  return CLUB_ORDER.map((club, index) => ({
    id: club,
    label: club,
    category:
      club === 'Driver' || club === 'Mini Driver'
        ? 'wood'
        : ['2W', '3W', '4W', '5W', '7W', '9W'].includes(club)
          ? 'wood'
          : ['2H', '3H', '4H', '5H', '6H', '7H'].includes(club)
            ? 'hybrid'
            : ['1i', '2i'].includes(club)
              ? 'iron'
              : ['AW', 'GW', 'SW', 'LW'].includes(club)
                ? 'wedge'
                : 'iron',
    active: activeClubIdSet.has(club),
    sortOrder: (index + 1) * 10,
  }))
}

const buildActiveBagConfig = (bagConfig: BagClubConfig[]) =>
  bagConfig
    .filter((club) => club.active)
    .sort((left, right) => left.sortOrder - right.sortOrder)

export let currentBagConfig: BagClubConfig[] = []
export let activeBagConfig: BagClubConfig[] = []
export let activeBagClubIds: Club[] = []
let bagConfigById = new Map<Club, BagClubConfig>()

export const refreshBagConfigState = () => {
  currentBagConfig = buildCurrentBagConfig(getActiveBagClubIds())
  activeBagConfig = buildActiveBagConfig(currentBagConfig)
  activeBagClubIds = activeBagConfig.map((club) => club.id)
  bagConfigById = new Map(currentBagConfig.map((club) => [club.id, club]))
}

refreshBagConfigState()

export const getClubConfig = (club: Club) => bagConfigById.get(club)

export const getClubLabel = (club: Club) => getClubConfig(club)?.label ?? club
