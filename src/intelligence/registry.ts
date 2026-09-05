import type { IntelligenceModelDefinition } from './contracts'
import { intelligenceModelDefinitions } from './models'

export const listIntelligenceModels = (): readonly IntelligenceModelDefinition[] =>
  intelligenceModelDefinitions

export const getIntelligenceModel = (
  modelId: string,
): IntelligenceModelDefinition | undefined =>
  intelligenceModelDefinitions.find((definition) => definition.id === modelId)

export const getDownstreamConsumers = (
  modelId: string,
): readonly IntelligenceModelDefinition[] =>
  intelligenceModelDefinitions.filter((definition) =>
    definition.dependencies.some((dependency) => dependency.modelId === modelId),
  )
