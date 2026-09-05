export type IntelligenceModelStatus =
  | 'legacy'
  | 'shadow'
  | 'active'
  | 'experimental'
  | 'retired'

export type IntelligenceParameterValue = number | string | boolean

export type IntelligenceParameterDefinition = {
  key: string
  label: string
  description: string
  defaultValue: IntelligenceParameterValue
  editable: boolean
  unit?: string
  min?: number
  max?: number
  step?: number
}

export type IntelligenceDependency = {
  modelId: string
  relationship: string
}

export type IntelligenceLegacyReference = {
  sourcePath: string
  symbol?: string
}

export type IntelligenceModelDefinition = {
  id: string
  name: string
  version: string
  status: IntelligenceModelStatus
  purpose: string
  question: string
  inputs: readonly string[]
  outputs: readonly string[]
  algorithmSummary: readonly string[]
  parameters: readonly IntelligenceParameterDefinition[]
  dependencies: readonly IntelligenceDependency[]
  downstreamConsumers: readonly IntelligenceDependency[]
  legacyReferences: readonly IntelligenceLegacyReference[]
  notes?: readonly string[]
}

export type IntelligenceTraceValue = number | string | boolean | null

export type IntelligenceTraceStep = {
  id: string
  label: string
  description: string
  values?: Readonly<Record<string, IntelligenceTraceValue>>
}

export type IntelligenceEvidence = {
  shotCount?: number
  sessionCount?: number
  warnings?: readonly string[]
}

export type IntelligenceResult<TValue> = {
  modelId: string
  modelVersion: string
  value: TValue
  explanation: string
  evidence: IntelligenceEvidence
  trace: readonly IntelligenceTraceStep[]
}
