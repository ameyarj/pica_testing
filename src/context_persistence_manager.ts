import fs from 'fs';
import path from 'path';
import { ExecutionContext, ActionResult } from './interfaces/interface';
import { CompactBatchContext } from './interfaces/compact_context';
import { ContextCompressor } from './utils/context_compressor';
import chalk from 'chalk';

export interface BatchContext {
  batchNumber: number;
  actionRange: string;
  context: ExecutionContext;
  refinedKnowledge: Map<string, string>;
  promptPatterns: Map<string, any>;
  timestamp: string;
  platform: string;
}

export class ContextPersistenceManager {
  private contextDir: string;
  private compressor: ContextCompressor;
  private lastIncrementalSave: Map<string, number> = new Map();
  private incrementalSaveInterval: number = 30000; 
  private actionsPerCheckpoint: number = 10; 

  constructor() {
    this.contextDir = path.join(process.cwd(), 'logs', 'contexts');
    if (!fs.existsSync(this.contextDir)) {
      fs.mkdirSync(this.contextDir, { recursive: true });
    }
    this.compressor = new ContextCompressor({
      maxRecentActions: 10,
      enablePruning: true,
      compressionThreshold: 50000
    });
  }

  saveContext(
    platform: string,
    batchNumber: number,
    context: ExecutionContext,
    actionRange?: string,
    refinedKnowledge?: Map<string, string>,
    promptPatterns?: Map<string, any>
  ): void {
    const contextFile = this.getContextFilename(platform, batchNumber);
    
    const batchContext: BatchContext = {
      batchNumber,
      actionRange: actionRange || '',
      context: this.serializeContext(context),
      refinedKnowledge: refinedKnowledge || new Map(),
      promptPatterns: promptPatterns || new Map(),
      timestamp: new Date().toISOString(),
      platform
    };

    const serializedContext = this.serializeBatchContext(batchContext);
    
    try {
      fs.writeFileSync(contextFile, JSON.stringify(serializedContext, null, 2));
      console.log(chalk.green(`   ✅ Saved context for batch ${batchNumber}`));
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save context: ${error}`));
    }
  }

  loadContext(platform: string, batchNumber?: number): ExecutionContext | null {
    if (batchNumber === undefined) {
      return this.loadLatestContext(platform);
    }

    const interruptContext = this.loadInterruptContext(platform, batchNumber);
    if (interruptContext) {
      return interruptContext;
    }

    const contextFile = this.getContextFilename(platform, batchNumber);
    
    if (!fs.existsSync(contextFile)) {
      console.log(chalk.yellow(`   ⚠️ No context found for batch ${batchNumber}`));
      return null;
    }

    try {
      const serializedContext = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
      const batchContext = this.deserializeBatchContext(serializedContext);
      console.log(chalk.green(`   ✅ Loaded context from batch ${batchNumber}`));
      return batchContext.context;
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to load context: ${error}`));
      return null;
    }
  }

  loadInterruptContext(platform: string, batchNumber: number): ExecutionContext | null {
    const interruptFile = this.getInterruptContextFilename(platform, batchNumber);
    
    if (!fs.existsSync(interruptFile)) {
      return null;
    }

    try {
      const interruptData = JSON.parse(fs.readFileSync(interruptFile, 'utf-8'));
      console.log(chalk.cyan(`   📍 Loaded interrupt context from batch ${batchNumber} (${interruptData.executedActions.length} actions)`));
      
      const context: ExecutionContext = {
        platformSummary: `Resumed from interrupted batch ${batchNumber}`,
        recentActions: interruptData.executedActions.map((action: any) => ({
          actionTitle: action.actionTitle,
          modelName: action.actionId,
          success: action.success,
          output: action.output
        })),
        createdResources: new Map(),
        availableIds: new Map(Object.entries(interruptData.availableResources || {})),
        availableNames: new Map()
      };

      interruptData.executedActions.forEach((action: any) => {
        if (action.extractedData) {
          if (action.extractedData.ids) {
            Object.entries(action.extractedData.ids).forEach(([key, value]) => {
              const existing = context.availableIds.get(key) || [];
              if (Array.isArray(value)) {
                context.availableIds.set(key, [...existing, ...value]);
              } else {
                context.availableIds.set(key, [...existing, value as string]);
              }
            });
          }
          
          if (action.extractedData.names) {
            Object.entries(action.extractedData.names).forEach(([key, value]) => {
              context.availableNames.set(key, value as string);
            });
          }
          
          if (action.extractedData.created_resources) {
            Object.entries(action.extractedData.created_resources).forEach(([key, value]) => {
              context.createdResources.set(key, value);
            });
          }
        }
      });

      return context;
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to load interrupt context: ${error}`));
      return null;
    }
  }

  private getInterruptContextFilename(platform: string, batchNumber: number): string {
    const safePlatformName = platform.replace(/[^a-zA-Z0-9\s-]/g, '_');
    return path.join(this.contextDir, `${safePlatformName}_batch_${batchNumber}_interrupt.json`);
  }

  loadBatchContext(platform: string, batchNumber: number): BatchContext | null {
    const contextFile = this.getContextFilename(platform, batchNumber);
    
    if (!fs.existsSync(contextFile)) {
      return null;
    }

    try {
      const serializedContext = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
      return this.deserializeBatchContext(serializedContext);
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to load batch context: ${error}`));
      return null;
    }
  }

  private loadLatestContext(platform: string): ExecutionContext | null {
    const contextFiles = this.getContextFiles(platform);
    if (contextFiles.length === 0) return null;

    const latestFile = contextFiles[contextFiles.length - 1];
    const batchNumber = this.extractBatchNumber(latestFile);
    
    return this.loadContext(platform, batchNumber);
  }

  private getContextFiles(platform: string): string[] {
    const files = fs.readdirSync(this.contextDir)
      .filter(file => file.startsWith(`${platform}_batch_`) && file.endsWith('_context.json'))
      .sort();
    
    return files;
  }

  private extractBatchNumber(filename: string): number {
    const match = filename.match(/_batch_(\d+)_context\.json$/);
    return match ? parseInt(match[1]) : 0;
  }

  private getContextFilename(platform: string, batchNumber: number): string {
    const safePlatformName = platform.replace(/[^a-zA-Z0-9\s-]/g, '_');
    return path.join(this.contextDir, `${safePlatformName}_batch_${batchNumber}_context.json`);
  }

  private serializeContext(context: ExecutionContext): any {
    try {
      const createdResources = this.safeSerializeMap(context.createdResources);
      const availableIds = this.safeSerializeIdsMap(context.availableIds);
      const availableNames = this.safeSerializeMap(context.availableNames);

      return {
        platformSummary: context.platformSummary || "",
        recentActions: context.recentActions || [],
        createdResources,
        availableIds,
        availableNames
      };
    } catch (error) {
      console.error(chalk.red(`   ❌ Error serializing context: ${error}`));
      return {
        platformSummary: context.platformSummary || "",
        recentActions: context.recentActions || [],
        createdResources: {},
        availableIds: {},
        availableNames: {}
      };
    }
  }

  private deserializeContext(data: any): ExecutionContext {
    return {
      platformSummary: data.platformSummary || "",
      recentActions: data.recentActions || [],
      createdResources: new Map(Object.entries(data.createdResources || {})),
      availableIds: new Map(
        Object.entries(data.availableIds || {}).map(([key, value]) => [key, Array.isArray(value) ? value : [value]])
      ),
      availableNames: new Map(Object.entries(data.availableNames || {}))
    };
  }

  private safeSerializeMap(map: Map<string, any> | undefined): any {
    if (!map) return {};
    
    try {
      if (map instanceof Map) {
        return Object.fromEntries(map);
      }
      
      if (typeof map === 'object' && map !== null) {
        return map;
      }
      
      return {};
    } catch (error) {
      console.error(chalk.red(`   ❌ Error serializing map: ${error}`));
      return {};
    }
  }

  private safeSerializeIdsMap(map: Map<string, string[]> | undefined): any {
    if (!map) return {};
    
    try {
      if (map instanceof Map) {
        const result: any = {};
        for (const [key, value] of map.entries()) {
          result[key] = Array.isArray(value) ? value : [value];
        }
        return result;
      }
      
      if (typeof map === 'object' && map !== null) {
        const result: any = {};
        for (const [key, value] of Object.entries(map)) {
          result[key] = Array.isArray(value) ? value : [value];
        }
        return result;
      }
      
      return {};
    } catch (error) {
      console.error(chalk.red(`   ❌ Error serializing IDs map: ${error}`));
      return {};
    }
  }

  private serializeBatchContext(batchContext: BatchContext): any {
    try {
      return {
        ...batchContext,
        context: this.serializeContext(batchContext.context),
        refinedKnowledge: this.safeSerializeMap(batchContext.refinedKnowledge),
        promptPatterns: this.safeSerializeMap(batchContext.promptPatterns)
      };
    } catch (error) {
      console.error(chalk.red(`   ❌ Error serializing batch context: ${error}`));
      return {
        batchNumber: batchContext.batchNumber,
        actionRange: batchContext.actionRange,
        context: {
          platformSummary: "",
          recentActions: [],
          createdResources: {},
          availableIds: {},
          availableNames: {}
        },
        refinedKnowledge: {},
        promptPatterns: {},
        timestamp: batchContext.timestamp,
        platform: batchContext.platform
      };
    }
  }

  private deserializeBatchContext(data: any): BatchContext {
    return {
      ...data,
      context: this.deserializeContext(data.context),
      refinedKnowledge: new Map(Object.entries(data.refinedKnowledge || {})),
      promptPatterns: new Map(Object.entries(data.promptPatterns || {}))
    };
  }

  getAvailableBatches(platform: string): number[] {
    const files = this.getContextFiles(platform);
    return files.map(file => this.extractBatchNumber(file)).sort((a, b) => a - b);
  }

  deleteBatch(platform: string, batchNumber: number): void {
    const contextFile = this.getContextFilename(platform, batchNumber);
    if (fs.existsSync(contextFile)) {
      fs.unlinkSync(contextFile);
      console.log(chalk.yellow(`   🗑️ Deleted context for batch ${batchNumber}`));
    }
  }

  saveIncrementalContext(
    platform: string,
    batchNumber: number,
    context: ExecutionContext,
    actionIndex: number,
    totalActions: number
  ): void {
    const now = Date.now();
    const key = `${platform}_${batchNumber}`;
    const lastSave = this.lastIncrementalSave.get(key) || 0;
    
    const shouldSaveByTime = (now - lastSave) > this.incrementalSaveInterval;
    const shouldSaveByActions = (actionIndex % this.actionsPerCheckpoint) === 0;
    
    if (shouldSaveByTime || shouldSaveByActions || actionIndex === totalActions - 1) {
      this.saveCheckpoint(platform, batchNumber, context, actionIndex, totalActions);
      this.lastIncrementalSave.set(key, now);
    }
  }

  private saveCheckpoint(
    platform: string,
    batchNumber: number,
    context: ExecutionContext,
    actionIndex: number,
    totalActions: number
  ): void {
    const checkpointFile = this.getCheckpointFilename(platform, batchNumber, actionIndex);
    
    const checkpoint = {
      platform,
      batchNumber,
      actionIndex,
      totalActions,
      timestamp: new Date().toISOString(),
      context: this.serializeContext(context),
      progress: Math.round((actionIndex / totalActions) * 100)
    };

    try {
      fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2));
      console.log(chalk.blue(`   💾 Checkpoint saved at action ${actionIndex}/${totalActions} (${checkpoint.progress}%)`));
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save checkpoint: ${error}`));
    }
  }

  loadLatestCheckpoint(platform: string, batchNumber: number): {
    context: ExecutionContext;
    actionIndex: number;
    totalActions: number;
  } | null {
    const checkpointFiles = this.getCheckpointFiles(platform, batchNumber);
    if (checkpointFiles.length === 0) return null;

    const latestFile = checkpointFiles[checkpointFiles.length - 1];
    const checkpointPath = path.join(this.contextDir, latestFile);

    try {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
      console.log(chalk.cyan(`   📍 Loaded checkpoint from action ${checkpoint.actionIndex}/${checkpoint.totalActions}`));
      
      return {
        context: this.deserializeContext(checkpoint.context),
        actionIndex: checkpoint.actionIndex,
        totalActions: checkpoint.totalActions
      };
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to load checkpoint: ${error}`));
      return null;
    }
  }

  private getCheckpointFiles(platform: string, batchNumber: number): string[] {
    const safePlatformName = platform.replace(/[^a-zA-Z0-9\s-]/g, '_');
    const prefix = `${safePlatformName}_batch_${batchNumber}_checkpoint_`;
    
    return fs.readdirSync(this.contextDir)
      .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
      .sort((a, b) => {
        const aIndex = parseInt(a.match(/checkpoint_(\d+)\.json$/)?.[1] || '0');
        const bIndex = parseInt(b.match(/checkpoint_(\d+)\.json$/)?.[1] || '0');
        return aIndex - bIndex;
      });
  }

  private getCheckpointFilename(platform: string, batchNumber: number, actionIndex: number): string {
    const safePlatformName = platform.replace(/[^a-zA-Z0-9\s-]/g, '_');
    return path.join(this.contextDir, `${safePlatformName}_batch_${batchNumber}_checkpoint_${actionIndex}.json`);
  }

  cleanupCheckpoints(platform: string, batchNumber: number): void {
    const checkpointFiles = this.getCheckpointFiles(platform, batchNumber);
    let cleanedCount = 0;

    for (const file of checkpointFiles) {
      const filePath = path.join(this.contextDir, file);
      try {
        fs.unlinkSync(filePath);
        cleanedCount++;
      } catch (error) {
        console.error(chalk.red(`   ❌ Failed to cleanup checkpoint ${file}: ${error}`));
      }
    }

    if (cleanedCount > 0) {
      console.log(chalk.yellow(`   🧹 Cleaned up ${cleanedCount} checkpoint files`));
    }
  }

  enhancedSaveInterruptState(
    platform: string,
    batchNumber: number,
    executionState: any,
    context: ExecutionContext
  ): void {
    const interruptFile = this.getInterruptContextFilename(platform, batchNumber);
    
    const enhancedInterruptData = {
      ...executionState,
      timestamp: new Date().toISOString(),
      context: this.serializeContext(context),
      recoveryMetadata: {
        canResume: true,
        lastAction: executionState.currentActionIndex,
        completedActions: executionState.executedActions.length,
        totalActions: executionState.executedActions.length + (executionState.remainingActions || 0)
      }
    };

    try {
      fs.writeFileSync(interruptFile, JSON.stringify(enhancedInterruptData, null, 2));
      console.log(chalk.green(`   💾 Enhanced interrupt state saved for batch ${batchNumber}`));
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save enhanced interrupt state: ${error}`));
    }
  }
  saveCompactContext(
    platform: string,
    batchNumber: number,
    context: ExecutionContext,
    results: ActionResult[],
    actionRange?: string,
    duration?: number
  ): void {
    try {
      const compactContext = this.compressor.compressContext(
        context,
        results,
        platform,
        batchNumber
      );

      const compactBatchContext: CompactBatchContext = {
        batchNumber,
        actionRange: actionRange || '',
        context: compactContext,
        timestamp: new Date().toISOString(),
        platform,
        batchMetadata: {
          duration: duration || 0,
          totalActions: results.length,
          successfulActions: results.filter(r => r.success).length,
          failedActions: results.filter(r => !r.success).length,
          knowledgeRefinements: results.filter(r => r.finalKnowledge && r.finalKnowledge !== r.originalKnowledge).length
        }
      };

      const serializedCompact = this.serializeCompactBatchContext(compactBatchContext);
      
      const compactFile = this.getCompactContextFilename(platform, batchNumber);
      fs.writeFileSync(compactFile, JSON.stringify(serializedCompact, null, 2));
      
      const originalSize = JSON.stringify(this.serializeBatchContext({
        batchNumber,
        actionRange: actionRange || '',
        context,
        refinedKnowledge: new Map(),
        promptPatterns: new Map(),
        timestamp: new Date().toISOString(),
        platform
      })).length;
      
      const compactSize = JSON.stringify(serializedCompact).length;
      const reduction = Math.round((1 - compactSize / originalSize) * 100);
      
      console.log(chalk.green(`   📦 Saved compact context for batch ${batchNumber} (${reduction}% smaller)`));
      
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save compact context: ${error}`));
      this.saveContext(platform, batchNumber, context, actionRange);
    }
  }

  loadCompactContext(platform: string, batchNumber?: number): ExecutionContext | null {
    const targetBatch = batchNumber || this.getLatestBatchNumber(platform);
    if (targetBatch === 0) return null;

    const compactFile = this.getCompactContextFilename(platform, targetBatch);
    
    if (fs.existsSync(compactFile)) {
      try {
        const serializedCompact = JSON.parse(fs.readFileSync(compactFile, 'utf-8'));
        const compactBatchContext = this.deserializeCompactBatchContext(serializedCompact);
        
        const expandedContext = this.compressor.expandContext(compactBatchContext.context);
        
        console.log(chalk.green(`   📦 Loaded and expanded compact context from batch ${targetBatch}`));
        return expandedContext;
        
      } catch (error) {
        console.error(chalk.red(`   ❌ Failed to load compact context: ${error}`));
      }
    }

    return this.loadContext(platform, targetBatch);
  }

  shouldCompressContext(context: ExecutionContext): boolean {
    const serializedSize = JSON.stringify(this.serializeContext(context)).length;
    return serializedSize > this.compressor['config'].compressionThreshold;
  }

  getContextSizeStats(platform: string, batchNumber: number): {
    originalSize: number;
    compactSize: number;
    reductionPercentage: number;
  } | null {
    const originalFile = this.getContextFilename(platform, batchNumber);
    const compactFile = this.getCompactContextFilename(platform, batchNumber);
    
    let originalSize = 0;
    let compactSize = 0;

    if (fs.existsSync(originalFile)) {
      originalSize = fs.statSync(originalFile).size;
    }

    if (fs.existsSync(compactFile)) {
      compactSize = fs.statSync(compactFile).size;
    }

    if (originalSize === 0 && compactSize === 0) return null;

    const effectiveOriginalSize = originalSize || compactSize * 3; 
    const reductionPercentage = originalSize > 0 ? Math.round((1 - compactSize / originalSize) * 100) : 0;

    return {
      originalSize: effectiveOriginalSize,
      compactSize,
      reductionPercentage
    };
  }

  migrateToCompactFormat(platform: string): void {
    const batches = this.getAvailableBatches(platform);
    let migratedCount = 0;

    console.log(chalk.blue(`\n🔄 Migrating ${batches.length} batches to compact format...`));

    for (const batchNumber of batches) {
      const compactFile = this.getCompactContextFilename(platform, batchNumber);
      
      if (fs.existsSync(compactFile)) continue;

      const context = this.loadContext(platform, batchNumber);
      if (context) {
        const mockResults: ActionResult[] = context.recentActions.map(action => ({
          success: action.success,
          output: action.output,
          error: action.error,
          originalKnowledge: '',
          attempts: 1,
          actionTitle: action.actionTitle,
          modelName: action.modelName
        }));

        this.saveCompactContext(platform, batchNumber, context, mockResults);
        migratedCount++;
      }
    }

    console.log(chalk.green(`   ✅ Migrated ${migratedCount} batches to compact format`));
  }

  private getCompactContextFilename(platform: string, batchNumber: number): string {
    const safePlatformName = platform.replace(/[^a-zA-Z0-9\s-]/g, '_');
    return path.join(this.contextDir, `${safePlatformName}_batch_${batchNumber}_compact.json`);
  }

  private getLatestBatchNumber(platform: string): number {
    const files = this.getContextFiles(platform);
    if (files.length === 0) return 0;
    const latestFile = files[files.length - 1];
    return this.extractBatchNumber(latestFile);
  }
  private serializeCompactBatchContext(compactBatch: CompactBatchContext): any {
    return {
      ...compactBatch,
      context: {
        summary: compactBatch.context.summary,
        resources: {
          ids: Object.fromEntries(compactBatch.context.resources.ids),
          names: Object.fromEntries(compactBatch.context.resources.names),
          relationships: Object.fromEntries(compactBatch.context.resources.relationships)
        },
        actionHistory: compactBatch.context.actionHistory,
        knowledgeIndex: {
          refinements: Object.fromEntries(compactBatch.context.knowledgeIndex.refinements),
          usageStats: Object.fromEntries(compactBatch.context.knowledgeIndex.usageStats),
          knowledgeFiles: Object.fromEntries(compactBatch.context.knowledgeIndex.knowledgeFiles)
        }
      }
    };
  }

  private deserializeCompactBatchContext(data: any): CompactBatchContext {
    return {
      ...data,
      context: {
        summary: data.context.summary,
        resources: {
          ids: new Map(Object.entries(data.context.resources.ids || {})),
          names: new Map(Object.entries(data.context.resources.names || {})),
          relationships: new Map(Object.entries(data.context.resources.relationships || {}))
        },
        actionHistory: data.context.actionHistory || [],
        knowledgeIndex: {
          refinements: new Map(Object.entries(data.context.knowledgeIndex.refinements || {})),
          usageStats: new Map(Object.entries(data.context.knowledgeIndex.usageStats || {})),
          knowledgeFiles: new Map(Object.entries(data.context.knowledgeIndex.knowledgeFiles || {}))
        }
      }
    };
  }
}
