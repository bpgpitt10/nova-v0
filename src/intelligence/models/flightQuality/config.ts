export type FlightQualityConfig = {
  fieldWeights: {
    descent: number
    spin: number
    spinAxis: number
    launch: number
  }
  minimumQualifiedShots: number
  minimumCoreFields: number
  provisionalMaxQualifiedShots: number
  availabilityAdjustment: {
    fourFields: number
    threeFields: number
    twoFields: number
  }
  denominatorFloors: {
    launch: number
    spin: number
    descent: number
    spinAxisAbsoluteMedian: number
  }
}

export const flightQualityLegacyV1Config: FlightQualityConfig = {
  fieldWeights: {
    descent: 0.35,
    spin: 0.3,
    spinAxis: 0.2,
    launch: 0.15,
  },
  minimumQualifiedShots: 8,
  minimumCoreFields: 2,
  provisionalMaxQualifiedShots: 14,
  availabilityAdjustment: {
    fourFields: 0,
    threeFields: -4,
    twoFields: -10,
  },
  denominatorFloors: {
    launch: 1,
    spin: 500,
    descent: 1,
    spinAxisAbsoluteMedian: 3,
  },
}
