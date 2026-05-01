import type { Club } from './bagConfig'

export type IronBucketMode = 'two' | 'three'

export type ClubBucket =
  | 'woods'
  | 'hybrids'
  | 'wedges'
  | 'short-irons'
  | 'mid-irons'
  | 'long-irons'

export type BagSetupSectionKey =
  | 'drivers'
  | 'fairway-woods'
  | 'hybrids'
  | 'long-irons'
  | 'mid-irons'
  | 'short-irons'
  | 'wedges'

const DRIVER_CLUBS: Club[] = ['Driver', 'Mini Driver']
const FAIRWAY_WOOD_CLUBS: Club[] = ['2W', '3W', '4W', '5W', '7W', '9W']
const HYBRID_CLUBS: Club[] = ['2H', '3H', '4H', '5H', '6H', '7H']
const WEDGE_CLUBS: Club[] = ['PW', 'AW', 'GW', 'SW', 'LW']

const DRIVER_SET = new Set<Club>(DRIVER_CLUBS)
const FAIRWAY_WOOD_SET = new Set<Club>(FAIRWAY_WOOD_CLUBS)
const HYBRID_SET = new Set<Club>(HYBRID_CLUBS)
const WEDGE_SET = new Set<Club>(WEDGE_CLUBS)

export const DEFAULT_IRON_BUCKET_MODE: IronBucketMode = 'three'

export const BAG_SETUP_SECTION_ORDER: BagSetupSectionKey[] = [
  'drivers',
  'fairway-woods',
  'hybrids',
  'long-irons',
  'mid-irons',
  'short-irons',
  'wedges',
]

export const getClubFamily = (clubId: Club): 'wood' | 'hybrid' | 'iron' | 'wedge' => {
  if (DRIVER_SET.has(clubId) || FAIRWAY_WOOD_SET.has(clubId)) {
    return 'wood'
  }

  if (HYBRID_SET.has(clubId)) {
    return 'hybrid'
  }

  if (WEDGE_SET.has(clubId)) {
    return 'wedge'
  }

  return 'iron'
}

export const getIronBucket = (
  clubId: Club,
  mode: IronBucketMode = DEFAULT_IRON_BUCKET_MODE,
): 'short' | 'mid' | 'long' | null => {
  if (getClubFamily(clubId) !== 'iron') {
    return null
  }

  if (mode === 'two') {
    return ['7i', '8i', '9i'].includes(clubId) ? 'short' : 'long'
  }

  if (clubId === '8i' || clubId === '9i') {
    return 'short'
  }

  if (clubId === '6i' || clubId === '7i') {
    return 'mid'
  }

  return 'long'
}

export const getClubBucket = (
  clubId: Club,
  mode: IronBucketMode = DEFAULT_IRON_BUCKET_MODE,
): ClubBucket => {
  const family = getClubFamily(clubId)

  if (family === 'wood') {
    return 'woods'
  }

  if (family === 'hybrid') {
    return 'hybrids'
  }

  if (family === 'wedge') {
    return 'wedges'
  }

  const ironBucket = getIronBucket(clubId, mode)
  if (ironBucket === 'short') {
    return 'short-irons'
  }
  if (ironBucket === 'mid') {
    return 'mid-irons'
  }
  return 'long-irons'
}

export const getClubBucketLabel = (bucket: ClubBucket) => {
  switch (bucket) {
    case 'woods':
      return 'Woods'
    case 'hybrids':
      return 'Hybrids'
    case 'wedges':
      return 'Wedges'
    case 'short-irons':
      return 'Short Irons'
    case 'mid-irons':
      return 'Mid Irons'
    case 'long-irons':
      return 'Long Irons'
  }
}

export const getBagSetupSectionKey = (
  clubId: Club,
  mode: IronBucketMode = DEFAULT_IRON_BUCKET_MODE,
): BagSetupSectionKey => {
  if (DRIVER_SET.has(clubId)) {
    return 'drivers'
  }

  const bucket = getClubBucket(clubId, mode)
  switch (bucket) {
    case 'woods':
      return 'fairway-woods'
    case 'hybrids':
      return 'hybrids'
    case 'wedges':
      return 'wedges'
    case 'short-irons':
      return 'short-irons'
    case 'mid-irons':
      return 'mid-irons'
    case 'long-irons':
      return 'long-irons'
  }
}

export const getBagSetupSectionLabel = (sectionKey: BagSetupSectionKey) => {
  switch (sectionKey) {
    case 'drivers':
      return 'Driver'
    case 'fairway-woods':
      return 'Fairway Woods'
    case 'hybrids':
      return 'Hybrids'
    case 'long-irons':
      return 'Long Irons'
    case 'mid-irons':
      return 'Mid Irons'
    case 'short-irons':
      return 'Short Irons'
    case 'wedges':
      return 'Wedges'
  }
}
