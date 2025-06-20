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