import { ModelDefinition, ExecutionContext, ActionResult } from './interfaces/interface';
import { ContextPersistenceManager } from './context_persistence_manager';
import { TestingHistoryManager } from './testing_history_manager';
import { EnhancedDependencyAnalyzer } from './dependency_analyzer';
import chalk from 'chalk';

export interface ActionSelection {
  type: 'continue' | 'range' | 'custom' | 'failed' | 'dependency-ordered';
  startIndex?: number;
  endIndex?: number;
  actionIds?: string[];
  platform?: string;
  batchSize?: number;
}

export interface BatchStrategy {
  needsContext: boolean;
  requiredBatches: number[];
  missingDependencies: string[];
  selectedActions: ModelDefinition[];
  batchNumber: number;
  isResume?: boolean;
  resumeContext?: any;
  dependencyGraph?: any; // Cache the dependency graph to avoid re-analysis
}

export interface BatchInfo {
  batchNumber: number;
  range: string;
  actionCount: number;
  successCount: number;
  duration: string;
  timestamp: string;
  status?: string;
  interruptedAt?: number;
}

export class BatchManager {
  private contextPersistence: ContextPersistenceManager;
  private historyManager: TestingHistoryManager;
  private dependencyAnalyzer: EnhancedDependencyAnalyzer;
  private cachedDependencyGraph: any = null; // Cache to avoid re-analysis

  constructor(useClaudeForAnalysis: boolean = true) {
    this.contextPersistence = new ContextPersistenceManager();
    this.historyManager = new TestingHistoryManager();
    this.dependencyAnalyzer = new EnhancedDependencyAnalyzer(useClaudeForAnalysis);
  }

  async selectActions(
    platform: string,
    allActions: ModelDefinition[]
  ): Promise<{ selection: ActionSelection; strategy: BatchStrategy }> {
    const history = this.historyManager.getHistory(platform);
    
    console.log(chalk.bold.cyan(`\n📋 Action Selection for ${platform}:`));
    console.log(`Total actions available: ${allActions.length}`);
    
    if (history.sessions.length > 0) {
      console.log(chalk.yellow('\n📚 Testing History:'));
      const lastSession = history.sessions[history.sessions.length - 1];
      console.log(`Last session: ${lastSession.date}`);
      lastSession.batches.forEach(batch => {
        console.log(`  Batch ${batch.batchNumber}: ${batch.range} (${batch.successCount}/${batch.actionCount} success)`);
      });
    }

    return { selection: { type: 'dependency-ordered', batchSize: 75 }, strategy: await this.createStrategy({ type: 'dependency-ordered', batchSize: 75 }, platform, allActions) };
  }

  async createStrategy(
    selection: ActionSelection,
    platform: string,
    allActions: ModelDefinition[]
  ): Promise<BatchStrategy> {
    let selectedActions: ModelDefinition[];
    let batchNumber = 1;
    let needsContext = false;
    let requiredBatches: number[] = [];

    switch (selection.type) {
      case 'dependency-ordered':
        console.log(chalk.blue(`\n🔄 Analyzing dependencies for ${allActions.length} actions...`));
        selectedActions = await this.sortActionsByDependencies(allActions, platform);
        console.log(chalk.green(`   ✅ Actions sorted by dependency order`));
        
        this.displayDependencyOrderedPlan(selectedActions, selection.batchSize || 75);
        console.log(chalk.green('\n🚀 Starting dependency-ordered execution...'));
        
        batchNumber = 1;
        return {
          needsContext: false,
          requiredBatches: [],
          missingDependencies: [],
          selectedActions,
          batchNumber,
          dependencyGraph: this.cachedDependencyGraph // Pass cached graph to avoid re-analysis
        };

      case 'continue':
        const interruptedBatch = this.historyManager.hasInterruptedBatch(platform);
        
        if (interruptedBatch.canResume) {
          console.log(chalk.cyan(`   📍 Resuming from interrupted batch ${interruptedBatch.batchInfo.batchNumber}`));
          return this.createResumeStrategy(interruptedBatch.batchInfo, allActions, platform);
        } else {
          const lastBatch = this.historyManager.getLatestBatch(platform);
          const lastEndIndex = this.getLastActionIndex(platform);
          const remainingActions = allActions.slice(lastEndIndex);
          console.log(chalk.blue(`\n🔄 Sorting ${remainingActions.length} remaining actions by dependency order...`));
          selectedActions = await this.sortActionsByDependencies(remainingActions, platform);
          console.log(chalk.green(`   ✅ Remaining actions sorted by dependency order`));
          batchNumber = lastBatch + 1;
          requiredBatches = Array.from({length: lastBatch}, (_, i) => i + 1);
          needsContext = true;
        }
        break;

      case 'range':
        const rangeActions = allActions.slice(selection.startIndex!, selection.endIndex! + 1);
        console.log(chalk.blue(`\n🔄 Sorting ${rangeActions.length} range actions by dependency order...`));
        selectedActions = await this.sortActionsByDependencies(rangeActions, platform);
        console.log(chalk.green(`   ✅ Range actions sorted by dependency order`));
        batchNumber = this.historyManager.getLatestBatch(platform) + 1;
        break;

      case 'custom':
        const customActions = allActions.filter(action => selection.actionIds?.includes(action._id));
        console.log(chalk.blue(`\n🔄 Sorting ${customActions.length} custom actions by dependency order...`));
        selectedActions = await this.sortActionsByDependencies(customActions, platform);
        console.log(chalk.green(`   ✅ Custom actions sorted by dependency order`));
        batchNumber = this.historyManager.getLatestBatch(platform) + 1;
        break;

      case 'failed':
        const failedActionIds = this.getFailedActionIds(platform);
        const failedActions = allActions.filter(action => failedActionIds.includes(action._id));
        selectedActions = await this.sortActionsByDependencies(failedActions, platform);
        console.log(chalk.blue(`   🔄 Sorted ${selectedActions.length} failed actions by dependency order`));
        batchNumber = this.historyManager.getLatestBatch(platform) + 1;
        const lastBatch = this.historyManager.getLatestBatch(platform);
        requiredBatches = Array.from({length: lastBatch}, (_, i) => i + 1);
        needsContext = true;
        break;

      default:
        throw new Error(`Unknown selection type: ${selection.type}`);
    }

    if (selection.type === 'range' || selection.type === 'custom') {
      const dependencyAnalysis = await this.analyzeActionDependencies(selectedActions, allActions, platform);
      return {
        needsContext: dependencyAnalysis.needsContext,
        requiredBatches: dependencyAnalysis.requiredBatches,
        missingDependencies: dependencyAnalysis.missingDependencies,
        selectedActions,
        batchNumber
      };
    }

    return {
      needsContext,
      requiredBatches,
      missingDependencies: [],
      selectedActions,
      batchNumber
    };
  }

  async sortActionsByDependencies(actions: ModelDefinition[], platform: string): Promise<ModelDefinition[]> {
    try {
      const dependencyGraph = await this.dependencyAnalyzer.analyzeDependencies(actions, platform);
      // Cache the dependency graph to avoid re-analysis in orchestrator
      this.cachedDependencyGraph = dependencyGraph;
      return this.dependencyAnalyzer.getSortedActions(dependencyGraph, actions);
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️ Dependency analysis failed, using original order: ${error}`));
      return actions;
    }
  }

  calculateOptimalBatches(sortedActions: ModelDefinition[], batchSize: number): ModelDefinition[][] {
    const batches: ModelDefinition[][] = [];
    let currentBatch: ModelDefinition[] = [];
    
    for (let i = 0; i < sortedActions.length; i++) {
      currentBatch.push(sortedActions[i]);
      
      const shouldSplit = currentBatch.length >= batchSize && 
                         this.isSafeBatchBoundary(sortedActions, i);
      
      if (shouldSplit || i === sortedActions.length - 1) {
        batches.push([...currentBatch]);
        currentBatch = [];
      }
    }
    
    return batches;
  }

  private isSafeBatchBoundary(actions: ModelDefinition[], index: number): boolean {
    if (index === actions.length - 1) return true;
    
    const currentAction = actions[index];
    const nextAction = actions[index + 1];
    
    return currentAction.modelName !== nextAction.modelName ||
           currentAction.connectionPlatform !== nextAction.connectionPlatform;
  }

  displayDependencyOrderedPlan(
    sortedActions: ModelDefinition[], 
    batchSize: number
  ): void {
    const batches = this.calculateOptimalBatches(sortedActions, batchSize);
    
    console.log(chalk.bold.cyan(`\n📋 Dependency-Ordered Execution Plan:`));
    console.log(chalk.cyan(`Total Actions: ${sortedActions.length}`));
    console.log(chalk.cyan(`Batch Size: ${batchSize}`));
    console.log(chalk.cyan(`Total Batches: ${batches.length}`));
    
    const previewBatches = Math.min(3, batches.length);
    for (let i = 0; i < previewBatches; i++) {
      const batch = batches[i];
      console.log(chalk.yellow(`\nBatch ${i + 1} (${batch.length} actions):`));
      batch.slice(0, 5).forEach((action, idx) => {
        console.log(`  ${idx + 1}. ${action.title} (${action.modelName})`);
      });
      if (batch.length > 5) {
        console.log(chalk.gray(`  ... and ${batch.length - 5} more actions`));
      }
    }
    
    if (batches.length > previewBatches) {
      console.log(chalk.gray(`\n... and ${batches.length - previewBatches} more batches`));
    }
    
    const estimatedMinutes = Math.ceil(sortedActions.length * 2); 
    const estimatedHours = Math.floor(estimatedMinutes / 60);
    const remainingMinutes = estimatedMinutes % 60;
    
    if (estimatedHours > 0) {
      console.log(chalk.blue(`\n⏱️  Estimated Duration: ${estimatedHours}h ${remainingMinutes}m`));
    } else {
      console.log(chalk.blue(`\n⏱️  Estimated Duration: ${remainingMinutes}m`));
    }
  }

  private createResumeStrategy(interruptedBatchInfo: any, allActions: ModelDefinition[], platform: string): BatchStrategy {
    const rangeMatch = interruptedBatchInfo.range.match(/(\d+)-(\d+)/);
    if (!rangeMatch) {
      throw new Error(`Invalid range format: ${interruptedBatchInfo.range}`);
    }
    
    const startIndex = parseInt(rangeMatch[1]) - 1; 
    const endIndex = parseInt(rangeMatch[2]) - 1;   
    const resumeFromIndex = startIndex + interruptedBatchInfo.interruptedAt; 
    
    const selectedActions = allActions.slice(resumeFromIndex, endIndex + 1);
    
    console.log(chalk.cyan(`   🔄 Resuming: Actions ${resumeFromIndex + 1}-${endIndex + 1} (${selectedActions.length} remaining)`));
    
    return {
      needsContext: true,
      requiredBatches: [interruptedBatchInfo.batchNumber], 
      missingDependencies: [],
      selectedActions,
      batchNumber: interruptedBatchInfo.batchNumber + 1, 
      isResume: true,
      resumeContext: interruptedBatchInfo
    };
  }

  async analyzeActionDependencies(
    selectedActions: ModelDefinition[],
    allActions: ModelDefinition[],
    platform?: string
  ): Promise<{
    needsContext: boolean;
    requiredBatches: number[];
    missingDependencies: string[];
  }> {
    const dependencyGraph = await this.dependencyAnalyzer.analyzeDependencies(allActions, platform || 'temp');
    const selectedIds = new Set(selectedActions.map(a => a._id));
    const missingDependencies: string[] = [];
    const requiredBatches: number[] = [];

    for (const action of selectedActions) {
      const actionNode = dependencyGraph.nodes.find(n => n.id === action._id);
      if (actionNode?.dependsOn) {
        for (const depId of actionNode.dependsOn) {
          if (!selectedIds.has(depId)) {
            missingDependencies.push(depId);
            if (platform) {
              const depBatch = this.findActionBatchInHistory(depId, allActions, platform);
              if (depBatch > 0) requiredBatches.push(depBatch);
            }
          }
        }
      }
    }

    return {
      needsContext: missingDependencies.length > 0,
      requiredBatches: [...new Set(requiredBatches)],
      missingDependencies
    };
  }

  async loadRequiredContext(platform: string, requiredBatches: number[]): Promise<ExecutionContext> {
    let mergedContext: ExecutionContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableIds: new Map(),
      availableNames: new Map()
    };

    for (const batchNumber of requiredBatches.sort()) {
      let batchContext = this.contextPersistence.loadCompactContext(platform, batchNumber);
      
      if (!batchContext) {
        batchContext = this.contextPersistence.loadContext(platform, batchNumber);
      }
      
      if (batchContext) {
        mergedContext = this.mergeContexts(mergedContext, batchContext);
        console.log(chalk.gray(`   📋 Merged context from batch ${batchNumber}`));
      }
    }

    const totalIds = mergedContext.availableIds?.size || 0;
    const totalNames = mergedContext.availableNames?.size || 0;
    const totalActions = mergedContext.recentActions.length;
    
    if (totalIds > 0 || totalNames > 0 || totalActions > 0) {
      console.log(chalk.green(`   ✅ Merged context: ${totalIds} IDs, ${totalNames} names, ${totalActions} actions`));
    }

    return mergedContext;
  }

  private mergeContexts(base: ExecutionContext, toMerge: ExecutionContext): ExecutionContext {
    const merged: ExecutionContext = {
      platformSummary: toMerge.platformSummary || base.platformSummary,
      recentActions: [...base.recentActions, ...toMerge.recentActions],
      createdResources: new Map([...base.createdResources, ...toMerge.createdResources]),
      availableIds: new Map([...base.availableIds, ...toMerge.availableIds]),
      availableNames: new Map([...base.availableNames, ...toMerge.availableNames])
    };

    return merged;
  }

  saveBatchResults(
    platform: string,
    batchNumber: number,
    range: string,
    results: ActionResult[],
    context: ExecutionContext,
    duration: number,
    refinedKnowledge?: Map<string, string>,
    promptPatterns?: Map<string, any>
  ): void {
    try {
      const shouldCompress = this.contextPersistence.shouldCompressContext(context);
      
      if (shouldCompress) {
        console.log(chalk.blue(`   📦 Context size exceeds threshold, using compression...`));
        this.contextPersistence.saveCompactContext(
          platform,
          batchNumber,
          context,
          results,
          range,
          duration
        );
      } else {
        this.contextPersistence.saveContext(
          platform, 
          batchNumber, 
          context, 
          range, 
          refinedKnowledge, 
          promptPatterns
        );
      }
      
      const batchInfo: BatchInfo = {
        batchNumber,
        range,
        actionCount: results.length,
        successCount: results.filter(r => r.success).length,
        duration: this.formatDuration(duration),
        timestamp: new Date().toISOString()
      };

      this.historyManager.addBatch(platform, batchInfo);
      
      if (shouldCompress) {
        const stats = this.contextPersistence.getContextSizeStats(platform, batchNumber);
        if (stats) {
          console.log(chalk.green(`   📊 Context compressed: ${stats.reductionPercentage}% size reduction`));
        }
      }
      
      console.log(chalk.green(`   ✅ Saved batch ${batchNumber} results and context`));
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save batch results: ${error}`));
      try {
        const batchInfo: BatchInfo = {
          batchNumber,
          range,
          actionCount: results.length,
          successCount: results.filter(r => r.success).length,
          duration: this.formatDuration(duration),
          timestamp: new Date().toISOString()
        };
        this.historyManager.addBatch(platform, batchInfo);
        console.log(chalk.yellow(`   ⚠️ Saved batch ${batchNumber} history only (context save failed)`));
      } catch (historyError) {
        console.error(chalk.red(`   ❌ Failed to save batch history: ${historyError}`));
      }
    }
  }

  private getLastActionIndex(platform: string): number {
    const history = this.historyManager.getHistory(platform);
    if (history.sessions.length === 0) return 0;
    
    const lastSession = history.sessions[history.sessions.length - 1];
    const lastBatch = lastSession.batches[lastSession.batches.length - 1];
    
    const rangeMatch = lastBatch.range.match(/(\d+)-(\d+)/);
    return rangeMatch ? parseInt(rangeMatch[2]) : 0;
  }


  findActionBatchInHistory(actionId: string, allActions: ModelDefinition[], platform: string): number {
    const actionIndex = allActions.findIndex(a => a._id === actionId);
    if (actionIndex < 0) return 0;
    
    const history = this.historyManager.getHistory(platform);
    

    for (const session of history.sessions) {
      for (const batch of session.batches) {
        const rangeMatch = batch.range.match(/(\d+)-(\d+)/);
        if (rangeMatch) {
          const startIndex = parseInt(rangeMatch[1]) - 1; 
          const endIndex = parseInt(rangeMatch[2]) - 1;   
          
          if (actionIndex >= startIndex && actionIndex <= endIndex) {
            return batch.batchNumber;
          }
        }
      }
    }
    
    return 0;
  }


  getFailedActionIds(platform: string): string[] {
    const failedIds: string[] = [];
    
    try {
      const logsDir = require('path').join(process.cwd(), 'logs', 'execution');
      const fs = require('fs');
      
      if (fs.existsSync(logsDir)) {
        const logFiles = fs.readdirSync(logsDir)
          .filter((file: string) => file.startsWith(platform) && file.endsWith('.json'))
          .sort();
        
        for (const logFile of logFiles.slice(-5)) {
          try {
            const logPath = require('path').join(logsDir, logFile);
            const logData = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
            
            if (logData.executions) {
              logData.executions.forEach((execution: any) => {
                if (!execution.response?.success && 
                    execution.actionId && 
                    !execution.response?.error?.includes('Permission') &&
                    !execution.response?.error?.includes('403')) {
                  failedIds.push(execution.actionId);
                }
              });
            }
          } catch (error) {
            continue;
          }
        }
      }
      
      const contextDir = require('path').join(process.cwd(), 'logs', 'contexts');
      if (fs.existsSync(contextDir)) {
        const contextFiles = fs.readdirSync(contextDir)
          .filter((file: string) => file.startsWith(platform) && file.endsWith('.json'))
          .sort();
        
        for (const contextFile of contextFiles.slice(-3)) { 
          try {
            const contextPath = require('path').join(contextDir, contextFile);
            const contextData = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
            
            if (contextData.context?.recentActions) {
              contextData.context.recentActions.forEach((action: any) => {
                if (!action.success && action.actionId && !action.error?.includes('Skipped')) {
                  failedIds.push(action.actionId);
                }
              });
            }
          } catch (error) {
            continue;
          }
        }
      }
      
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️ Could not read execution logs: ${error}`));
    }
    
    const uniqueFailedIds = [...new Set(failedIds)];
    
    if (uniqueFailedIds.length > 0) {
      console.log(chalk.yellow(`   📋 Found ${uniqueFailedIds.length} previously failed actions`));
    } else {
      console.log(chalk.gray(`   ℹ️ No previously failed actions found`));
    }
    
    return uniqueFailedIds;
  }

  getFailedActionsInfo(platform: string, allActions: ModelDefinition[]): Array<{
    action: ModelDefinition;
    lastError: string;
    attempts: number;
    lastAttemptDate: string;
  }> {
    const failedIds = this.getFailedActionIds(platform);
    const failedActionsInfo: Array<{
      action: ModelDefinition;
      lastError: string;
      attempts: number;
      lastAttemptDate: string;
    }> = [];
    
    failedIds.forEach(actionId => {
      const action = allActions.find(a => a._id === actionId);
      if (action) {
        failedActionsInfo.push({
          action,
          lastError: 'Action execution failed',
          attempts: 1,
          lastAttemptDate: new Date().toISOString().split('T')[0]
        });
      }
    });
    
    return failedActionsInfo;
  }

  displayFailedActionsSummary(platform: string, allActions: ModelDefinition[]): void {
    const failedActionsInfo = this.getFailedActionsInfo(platform, allActions);
    
    if (failedActionsInfo.length === 0) {
      console.log(chalk.green(`   ✅ No failed actions found for ${platform}`));
      return;
    }
    
    console.log(chalk.yellow(`\n🔄 Previously Failed Actions (${failedActionsInfo.length}):`));
    failedActionsInfo.forEach((info, index) => {
      console.log(`${chalk.red(String(index + 1).padStart(2))}. ${info.action.title} (${info.action.modelName})`);
      console.log(`     Last error: ${chalk.gray(info.lastError.substring(0, 60))}...`);
    });
  }

  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }
}
