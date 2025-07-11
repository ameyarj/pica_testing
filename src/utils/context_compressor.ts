import { ExecutionContext, ActionResult } from '../interfaces/interface';

interface EnhancedActionResult extends ActionResult {
  strategyUsed?: string;
  passNumber?: number;
}
import { 
  CompactContext, 
  ContextSummary, 
  ResourceRegistry, 
  ActionDigest, 
  KnowledgeIndex, 
  ResourceInfo,
  ContextCompressionConfig
} from '../interfaces/compact_context';
import chalk from 'chalk';

export class ContextCompressor {
  private config: ContextCompressionConfig;

  constructor(config?: Partial<ContextCompressionConfig>) {
    this.config = {
      maxRecentActions: 5, 
      maxResourceAge: 7 * 24 * 60 * 60 * 1000,
      maxKnowledgeAge: 30 * 24 * 60 * 60 * 1000, 
      enablePruning: true,
      compressionThreshold: 20000, 
      ...config
    };
  }

  compressContext(
    context: ExecutionContext,
    results: ActionResult[],
    platformName: string,
    batchNumber: number
  ): CompactContext {
    const startTime = Date.now();
    
    const resources = this.createResourceRegistry(context, results);
    
    const actionHistory = this.createActionDigests(context.recentActions, results);
    
    const knowledgeIndex = this.createKnowledgeIndex(results);
    
    const summary = this.createContextSummary(
      platformName,
      batchNumber,
      context,
      results,
      resources
    );

    const compactContext: CompactContext = {
      summary,
      resources,
      actionHistory,
      knowledgeIndex
    };

    const compressionTime = Date.now() - startTime;
    console.log(chalk.green(`   📦 Context compressed in ${compressionTime}ms`));
    
    return compactContext;
  }

  private createResourceRegistry(
    context: ExecutionContext,
    results: ActionResult[]
  ): ResourceRegistry {
    const now = Date.now();
    const ids = new Map<string, ResourceInfo>();
    const names = new Map<string, string>();
    const relationships = new Map<string, string[]>();

    if (context.availableIds) {
      for (const [key, values] of context.availableIds) {
        const uniqueValues = Array.from(new Set(values));
        
        uniqueValues.forEach((value, index) => {
          const resourceKey = `${key}_${index}`;
          
          const createdBy = this.findCreatorAction(value, results);
          
          ids.set(resourceKey, {
            value,
            type: this.inferResourceType(key),
            createdBy: createdBy || 'unknown',
            createdAt: now,
            usageCount: 1
          });
        });
      }
    }

    if (context.availableNames) {
      for (const [key, name] of context.availableNames) {
        names.set(key, name);
      }
    }

    if (context.createdResources) {
      for (const [key, resource] of context.createdResources) {
        if (this.isResourceWithRelationships(resource)) {
          const childIds = this.extractChildIds(resource);
          if (childIds.length > 0) {
            relationships.set(key, childIds);
          }
        }
      }
    }

    return { ids, names, relationships };
  }

  private createActionDigests(
    recentActions: any[],
    results: ActionResult[]
  ): ActionDigest[] {
    const digests: ActionDigest[] = [];
    
    const actionsToProcess = recentActions.slice(-this.config.maxRecentActions);
    
    actionsToProcess.forEach((action, index) => {
      const result = results.find(r => 
        r.actionTitle === action.actionTitle && 
        r.modelName === action.modelName
      );

      const digest: ActionDigest = {
        actionId: result?.actionId || `action_${index}`,
        title: action.actionTitle,
        model: action.modelName,
        success: action.success,
        timestamp: Date.now(),
        attempts: result?.attempts || 1,
        summary: this.createActionSummary(action, result),
        metadata: this.extractCompactMetadata(action, result)
      };

      digests.push(digest);
    });

    return digests;
  }

  private createActionSummary(action: any, result?: ActionResult): ActionDigest['summary'] {
    const summary: ActionDigest['summary'] = {};

    if (result?.extractedData) {
      if (result.extractedData.ids) {
        summary.created = Object.values(result.extractedData.ids).filter(id => 
          typeof id === 'string' && id.length > 0
        ) as string[];
      }

      if (!action.success && action.error) {
        summary.errorType = action.error;
        summary.errorCategory = this.categorizeError(action.error);
      }
    }

    return Object.keys(summary).length > 0 ? summary : undefined;
  }

  private createKnowledgeIndex(results: ActionResult[]): KnowledgeIndex {
    const refinements = new Map<string, string>();
    const usageStats = new Map<string, any>();
    const knowledgeFiles = new Map<string, string>();

    results.forEach(result => {
      if (result.finalKnowledge && result.finalKnowledge !== result.originalKnowledge) {
        const actionId = result.actionId || result.actionTitle;
        
        const knowledgeHash = this.createKnowledgeHash(result.finalKnowledge);
        refinements.set(actionId, knowledgeHash);
        
        usageStats.set(actionId, {
          timesUsed: 1,
          lastUsed: Date.now(),
          successRate: result.success ? 1.0 : 0.0
        });

        knowledgeFiles.set(actionId, `knowledge/${actionId}.md`);
      }
    });

    return { refinements, usageStats, knowledgeFiles };
  }

  private createContextSummary(
    platformName: string,
    batchNumber: number,
    context: ExecutionContext,
    results: ActionResult[],
    resources: ResourceRegistry
  ): ContextSummary {
    const successfulActions = results.filter(r => r.success);
    const failedActions = results.filter(r => !r.success);
    
    const resourceCounts: { [key: string]: number } = {};
    for (const [, resource] of resources.ids) {
      resourceCounts[resource.type] = (resourceCounts[resource.type] || 0) + 1;
    }

    const recentMilestones = this.extractMilestones(context, results);

    const workflowStatus = {
      lastSuccessfulAction: successfulActions.length > 0 ? 
        successfulActions[successfulActions.length - 1].actionTitle : 'none',
      lastFailedAction: failedActions.length > 0 ? 
        failedActions[failedActions.length - 1].actionTitle : undefined,
      currentPhase: this.determineWorkflowPhase(results)
    };

    return {
      platformName,
      batchNumber,
      totalActions: results.length,
      successRate: results.length > 0 ? successfulActions.length / results.length : 0,
      resourceCounts,
      recentMilestones,
      workflowStatus
    };
  }

  private extractCompactMetadata(action: any, result?: ActionResult): any {
    const metadata: any = {};

    const enhancedResult = result as EnhancedActionResult;

    if (enhancedResult?.strategyUsed) {
      metadata.strategy = enhancedResult.strategyUsed;
    }

    if (enhancedResult?.passNumber) {
      metadata.pass = enhancedResult.passNumber;
    }

    if (action.error && action.error.length < 100) {
      metadata.errorPreview = action.error.substring(0, 100);
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private findCreatorAction(value: string, results: ActionResult[]): string | undefined {
    for (const result of results) {
      if (result.extractedData?.ids && Object.values(result.extractedData.ids).includes(value)) {
        return result.actionId || result.actionTitle;
      }
    }
    return undefined;
  }

  private inferResourceType(key: string): string {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('site')) return 'site';
    if (lowerKey.includes('deploy')) return 'deployment';
    if (lowerKey.includes('ticket') || lowerKey.includes('issue')) return 'ticket';
    if (lowerKey.includes('asset')) return 'asset';
    if (lowerKey.includes('user')) return 'user';
    return 'resource';
  }

  private isResourceWithRelationships(resource: any): boolean {
    return typeof resource === 'object' && resource !== null && 
           (resource.children || resource.dependencies || resource.related);
  }

  private extractChildIds(resource: any): string[] {
    const ids: string[] = [];
    if (resource.children) ids.push(...resource.children);
    if (resource.dependencies) ids.push(...resource.dependencies);
    if (resource.related) ids.push(...resource.related);
    return ids;
  }

  private categorizeError(error: string): 'permission' | 'validation' | 'network' | 'unknown' {
    const lowerError = error.toLowerCase();
    if (lowerError.includes('403') || lowerError.includes('unauthorized') || 
        lowerError.includes('permission')) return 'permission';
    if (lowerError.includes('400') || lowerError.includes('validation') || 
        lowerError.includes('invalid')) return 'validation';
    if (lowerError.includes('timeout') || lowerError.includes('network') || 
        lowerError.includes('connection')) return 'network';
    return 'unknown';
  }

  private createKnowledgeHash(knowledge: string): string {
    return btoa(knowledge.substring(0, 100)).substring(0, 16);
  }

  private extractMilestones(context: ExecutionContext, results: ActionResult[]): string[] {
    const milestones: string[] = [];
    
    const significantActions = results.filter(r => 
      r.success && (r.actionTitle.includes('Create') || r.actionTitle.includes('Deploy'))
    );
    
    significantActions.slice(-3).forEach(action => {
      milestones.push(`${action.actionTitle} completed successfully`);
    });

    if (context.availableIds) {
      const resourceCount = context.availableIds.size;
      if (resourceCount > 0) {
        milestones.push(`${resourceCount} resources available in context`);
      }
    }

    return milestones;
  }

  private determineWorkflowPhase(results: ActionResult[]): string {
    const recentActions = results.slice(-3);
    const actionTypes = recentActions.map(r => r.actionTitle.toLowerCase());
    
    if (actionTypes.some(a => a.includes('create'))) return 'resource_creation';
    if (actionTypes.some(a => a.includes('deploy'))) return 'deployment';
    if (actionTypes.some(a => a.includes('config'))) return 'configuration';
    if (actionTypes.some(a => a.includes('delete'))) return 'cleanup';
    
    return 'general_operations';
  }

  expandContext(compact: CompactContext): ExecutionContext {
    const expanded: ExecutionContext = {
      platformSummary: this.createExpandedSummary(compact.summary),
      recentActions: this.expandActionHistory(compact.actionHistory),
      createdResources: new Map(),
      availableIds: this.expandResourceIds(compact.resources),
      availableNames: compact.resources.names
    };

    return expanded;
  }

  private createExpandedSummary(summary: ContextSummary): string {
    let expandedSummary = `Platform: ${summary.platformName}\n`;
    expandedSummary += `Batch: ${summary.batchNumber}\n`;
    expandedSummary += `Success Rate: ${Math.round(summary.successRate * 100)}%\n`;
    expandedSummary += `Total Actions: ${summary.totalActions}\n\n`;

    if (summary.recentMilestones.length > 0) {
      expandedSummary += `Recent Milestones:\n`;
      summary.recentMilestones.forEach(milestone => {
        expandedSummary += `- ${milestone}\n`;
      });
    }

    if (Object.keys(summary.resourceCounts).length > 0) {
      expandedSummary += `\nResource Summary:\n`;
      Object.entries(summary.resourceCounts).forEach(([type, count]) => {
        expandedSummary += `- ${type}: ${count}\n`;
      });
    }

    return expandedSummary;
  }

  private expandActionHistory(digests: ActionDigest[]): any[] {
    return digests.map(digest => ({
      actionTitle: digest.title,
      modelName: digest.model,
      success: digest.success,
      error: digest.summary?.errorType,
      output: digest.success ? 'Action completed successfully' : digest.summary?.errorType
    }));
  }

  private expandResourceIds(resources: ResourceRegistry): Map<string, string[]> {
    const expandedIds = new Map<string, string[]>();
    
    const resourcesByType = new Map<string, string[]>();
    
    for (const [key, resource] of resources.ids) {
      const type = resource.type;
      if (!resourcesByType.has(type)) {
        resourcesByType.set(type, []);
      }
      resourcesByType.get(type)!.push(resource.value);
    }

    for (const [type, values] of resourcesByType) {
      expandedIds.set(type + 'Id', values);
    }

    return expandedIds;
  }
}
