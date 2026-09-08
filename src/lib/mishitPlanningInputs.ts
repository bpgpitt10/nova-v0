export const MISHIT_PLANNING_POLICY_VERSION = 1

/**
 * Looper application policy, deliberately separate from classifier math.
 *
 * The classifier can continue running in shadow even when planning filtering is
 * disabled. A future centralized Inputs page can surface this switch without
 * editing downstream Stock/Pure/driver code.
 */
export const MISHIT_PLANNING_INPUTS = {
  version: MISHIT_PLANNING_POLICY_VERSION,
  filterPlanningCalculations: true,
} as const

export const MISHIT_PLANNING_INPUT_DEFINITIONS = [
  {
    path: 'filterPlanningCalculations',
    label: 'Exclude mishits from planning calculations',
    group: 'Mishit planning policy',
    scope: 'global_policy' as const,
    kind: 'boolean' as const,
    description:
      'When enabled, mishit and severe-mishit classifications remain in raw history but are excluded from Stock, Pure, performance drivers, planning trends, dispersion, and related planning calculations.',
  },
]
