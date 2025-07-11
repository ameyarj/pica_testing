export interface CompactContext {
  summary: ContextSummary;
  resources: ResourceRegistry;
  actionHistory: ActionDigest[];
  knowledgeIndex: KnowledgeIndex;
}

export interface ContextSummary {
  platformName: string;
  batchNumber: number;
  totalActions: number;
  successRate: number;
  
  resourceCounts: {
    [resourceType: string]: number;
  };
  
  recentMilestones: string[];
  
  workflowStatus: {
    lastSuccessfulAction: string;
    lastFailedAction?: string;
    currentPhase: string;
  };
}

export interface ResourceRegistry {
  ids: Map<string, ResourceInfo>;
  names: Map<string, string>;
  relationships: Map<string, string[]>; 
}

export interface ResourceInfo {
  value: string;
  type: string;
  createdBy: string;  
  createdAt: number;  
  lastUsed?: number;  
  usageCount: number;
}

export interface ActionDigest {
  actionId: string;
  title: string;
  model: string;
  success: boolean;
  timestamp: number;
  attempts: number;
  
  summary?: {
    created?: string[];     
    modified?: string[];   
    deleted?: string[];     
    errorType?: string;    
    errorCategory?: 'permission' | 'validation' | 'network' | 'unknown';
  };
  
  metadata?: {
    [key: string]: any;
  };
}

export interface KnowledgeIndex {
  refinements: Map<string, string>;
  
  usageStats: Map<string, {
    timesUsed: number;
    lastUsed: number;
    successRate: number;
  }>;
  
  knowledgeFiles: Map<string, string>; 
}

export interface CompactBatchContext {
  batchNumber: number;
  actionRange: string;
  context: CompactContext;
  timestamp: string;
  platform: string;
  
  batchMetadata: {
    duration: number;
    totalActions: number;
    successfulActions: number;
    failedActions: number;
    knowledgeRefinements: number;
  };
}

export interface ContextCompressionConfig {
  maxRecentActions: number;
  maxResourceAge: number; 
  maxKnowledgeAge: number;
  enablePruning: boolean;
  compressionThreshold: number;
}
