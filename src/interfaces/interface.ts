export interface ConnectionDefinition {
  _id: string;
  platform: string;
  name: string;
  status: string;
}

export interface ModelDefinition {
  _id: string;
  connectionPlatform: string;
  connectionDefinitionId: string;
  title: string;
  name: string;
  modelName: string;
  action: string;
  actionName: string;
  knowledge: string;
  path: string;
  supported?: boolean; 
}

export interface ActionResult {
  success: boolean;
  output?: any;
  error?: string;
  originalKnowledge: string;
  finalKnowledge?: string;
  attempts: number;
  actionTitle: string;
  modelName: string;
  dependencies?: string[];
  contextUsed?: boolean;
  extractedData?: any;
  agentResponse?: string;
  analysisReason?: string;
  isPermissionError?: boolean;
  actionId?: string;

}

export interface ExecutionContext {
  platformSummary: string;
  recentActions: Array<{
    actionTitle: string;
    modelName: string;
    success: boolean;
    output?: any;
    error?: string;
  }>;
  createdResources: Map<string, any>;
  availableIds: Map<string, string[]>;
  availableNames: Map<string, string>;
}

export interface ExtractedDataEnhanced {
  ids: Record<string, string>;
  names: Record<string, string>;
  emails: string[];
  phones: string[];
  metadata: Record<string, any>;
}

export interface ParameterInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  example?: any;
}


export interface PromptGenerationContext {
  executionContext: ExecutionContext;
  
  dependencies: {
    graph: any; 
    currentAction: ModelDefinition;
    completedDependencies: Set<string>;
    availableResources: Map<string, any>;
    requiredIds: string[];
    providedIds: string[];
  };
  
  conversationHistory: {
    previousPrompts: string[];
    previousResponses: string[];
    extractedData: ExtractedDataEnhanced[];
    conversationFlow: string;
  };
  
  platformContext: {
    platform: string;
    terminology: Map<string, string>;
    useCase: string;
    scenario: string;
    businessContext: string;
  };
  
  metadata: {
    attemptNumber: number;
    previousError?: string;
    isRetry: boolean;
    totalActionsInSequence: number;
    currentActionIndex: number;
  };
}

export interface UseCase {
  name: string; 
  description: string;
  scenarios: Scenario[];
  terminology: Map<string, string>; 
  commonFlows: string[];
}

export interface Scenario {
  name: string; 
  description: string;
  steps: ScenarioStep[];
  examplePrompts: string[];
  dependencies: string[];
}

export interface ScenarioStep {
  actionType: string;
  description: string;
  examplePrompt: string;
  requiredContext: string[];
  providedContext: string[];
}

export interface PlatformProfile {
  platform: string;
  primaryUseCase: UseCase;
  supportedUseCases: UseCase[];
  terminology: Map<string, string>;
  businessContext: string;
  typicalWorkflows: string[];
}

export interface PromptSequence {
  platform: string;
  scenario: string;
  steps: PromptStep[];
  totalSteps: number;
  estimatedDuration: number;
}

export interface PromptStep {
  actionId: string;
  action: ModelDefinition;
  prompt: string;
  context: PromptGenerationContext;
  dependencies: string[];
  expectedOutputs: string[];
}

export interface LLMPromptGenerationRequest {
  action: ModelDefinition;
  context: PromptGenerationContext;
  style: 'conversational' | 'business' | 'technical' | 'casual';
  tone: 'friendly' | 'professional' | 'direct' | 'enthusiastic';
}

export interface LLMPromptGenerationResponse {
  prompt: string;
  confidence: number;
  reasoning: string;
  alternativePrompts: string[];
  contextUsed: string[];
  suggestedTestData: Record<string, any>;
}

export interface PromptLearningData {
  prompt: string;
  action: ModelDefinition;
  context: PromptGenerationContext;
  success: boolean;
  error?: string;
  agentResponse?: string;
  executionTime: number;
  timestamp: number;
}

export interface PromptPattern {
  pattern: string;
  successRate: number;
  platforms: string[];
  actionTypes: string[];
  contextRequirements: string[];
  examples: string[];
}

export interface PromptStrategy {
  tone: 'conversational' | 'technical' | 'step-by-step' | 'contextual';
  emphasis: string[];
  examples: boolean;
  contextLevel: 'minimal' | 'moderate' | 'extensive';
}


export interface RefinementAnalysis {
  errorType: 'missing_parameter' | 'format_error' | 'resource_not_found' | 'permission_error' | 'duplicate_resource' | 'unknown';
  missingParams: string[];
  contextAvailable: Record<string, string>;
  suggestedFixes: string[];
  confidence: number;
}

export interface KnowledgeRefinementContext {
  originalKnowledge: string;
  errorMessage: string;
  actionDetails: ModelDefinition;
  executionContext?: ExecutionContext;
  platformProfile?: PlatformProfile;
  conversationHistory?: {
    prompts: string[];
    responses: string[];
    extractedData: any[];
  };
  previousExecutions?: ExecutionHistory[];
}

export interface ExecutionHistory {
  action: ModelDefinition;
  prompt: string;
  success: boolean;
  error?: string;
  extractedData?: ExtractedDataEnhanced;
  timestamp: number;
  platform: string;
}

export interface RefinedKnowledge {
  knowledge?: string;
  promptStrategy?: string;
  contextMapping?: Record<string, string>;
  additionalSteps?: string[];
  confidence: number;
  reasoning: string;
}

export interface BatchSelection {
  type: 'all' | 'continue' | 'range' | 'custom';
  startIndex?: number;
  endIndex?: number;
  actionIds?: string[];
}

export interface BatchMetadata {
  batchNumber: number;
  actionRange: string;
  totalBatches: number;
  previousBatches: number[];
}