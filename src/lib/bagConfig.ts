export type Club =
  | 'Driver'
  | '3W'
  | '3H'
  | '5i'
  | '6i'
  | '7i'
  | '8i'
  | '9i'
  | 'PW'
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

export const currentBagConfig: BagClubConfig[] = [
  { id: 'Driver', label: 'Driver', category: 'wood', active: true, sortOrder: 10 },
  { id: '3W', label: '3W', category: 'wood', active: true, sortOrder: 20 },
  { id: '3H', label: '3H', category: 'hybrid', active: true, sortOrder: 30 },
  { id: '5i', label: '5i', category: 'iron', active: true, sortOrder: 40 },
  { id: '6i', label: '6i', category: 'iron', active: true, sortOrder: 50 },
  { id: '7i', label: '7i', category: 'iron', active: true, sortOrder: 60 },
  { id: '8i', label: '8i', category: 'iron', active: true, sortOrder: 70 },
  { id: '9i', label: '9i', category: 'iron', active: true, sortOrder: 80 },
  { id: 'PW', label: 'PW', category: 'wedge', active: true, sortOrder: 90 },
  { id: 'GW', label: 'GW', category: 'wedge', active: true, sortOrder: 100 },
  { id: 'SW', label: 'SW', category: 'wedge', active: true, sortOrder: 110 },
  { id: 'LW', label: 'LW', category: 'wedge', active: true, sortOrder: 120 },
]

export const activeBagConfig = currentBagConfig
  .filter((club) => club.active)
  .sort((left, right) => left.sortOrder - right.sortOrder)

export const activeBagClubIds: Club[] = activeBagConfig.map((club) => club.id)

const bagConfigById = new Map(currentBagConfig.map((club) => [club.id, club]))

export const getClubConfig = (club: Club) => bagConfigById.get(club)

export const getClubLabel = (club: Club) => getClubConfig(club)?.label ?? club
