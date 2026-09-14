export const greywolfHole01LieEvidence = {
  source: {
    round: 215,
    artifact: 'artifacts/osm-proof/lidar/greywolf-gspro-lie-observations.json',
    sourceBranch: 'hazard-field-lab-v0',
  },
  observedSurfaceEnums: [
    { raw: 18, label: 'tee' },
    { raw: 2, label: 'fairway' },
    { raw: 1, label: 'rough' },
    { raw: 11, label: 'sand' },
    { raw: 5, label: 'green' },
  ],
  shots: [
    {
      label: 'Round 215 • shot 1 finish',
      gsproSurfaceEnum: 3,
      gsproSurfaceStatus: 'unmapped',
      osmGround: 'rough',
      penaltyEvidenceCaptured: false,
    },
    {
      label: 'Round 215 • shot 2 finish',
      gsproSurfaceEnum: 3,
      gsproSurfaceStatus: 'unmapped',
      osmGround: 'rough',
      penaltyEvidenceCaptured: false,
    },
  ],
  interpretation: {
    osmGroundPolicy: 'OSM golf=rough remains rough',
    enumThreePolicy: 'Distinct from observed rough enum 1; do not name until field-validated',
    recoveryPolicy: 'Vegetation and line-of-play obstruction remain separate from ground surface',
    nextValidation: 'Capture the GSPro surface title and penalty modifiers at known enum 1 and enum 3 lies',
  },
} as const
