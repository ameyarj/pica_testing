import { PicaApiService } from './connectors/pica_api_service';
import { EnhancedAgentService } from './agent_service';
import { KnowledgeRefiner } from './knowledge_refiner';
import { EnhancedContextManager } from './enhanced_context_manager';
import { EnhancedDependencyAnalyzer } from './dependency_analyzer';
import { EnhancedPromptGenerator } from './prompt_generator';
import { ConnectionDefinition, ModelDefinition, ActionResult, ExecutionContext, SkippedActionInfo } from './interfaces/interface';
import { PathParameterResolver } from './path_resolver';
import { ExecutionLogger } from './execution_logger';
import { BatchManager, ActionSelection, BatchStrategy } from './batch_manager';
import { TestingHistoryManager } from './testing_history_manager';
import { TokenActionDetector } from './utils/tokenActionDetector';
import { PlatformSelector } from './utils/platform_selector';
import readline from 'readline/promises';
import chalk from 'chalk';
import * as diff from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import { tokenTracker } from './global_token_tracker';

function createRailwayReadlineInterface() {
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(chalk.blue('🚂 Creating Railway-compatible readline interface...'));
  }
  
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
}

let rl = createRailwayReadlineInterface();

rl.on('close', () => {
  console.log(chalk.yellow('🔄 Readline interface closed, recreating...'));
  rl = createRailwayReadlineInterface();
});

rl.on('error', (error) => {
  console.error(chalk.red('❌ Readline error:', error.message));
  if (error.message.includes('ERR_USE_AFTER_CLOSE')) {
    console.log(chalk.blue('🔄 Recreating readline interface...'));
    rl = createRailwayReadlineInterface();
  }
});

interface EnhancedActionResult extends ActionResult {
  passNumber: number;
  strategyUsed?: string;
  dependenciesMet: boolean;
  analysisReason?: string;
}
export class EnhancedPicaosTestingOrchestrator {
  private picaApiService: PicaApiService;
  private agentService: EnhancedAgentService;
  private knowledgeRefiner: KnowledgeRefiner;
  private contextManager: EnhancedContextManager;
  private dependencyAnalyzer: EnhancedDependencyAnalyzer;
  private promptGenerator: EnhancedPromptGenerator;
  private maxRetriesPerAction: number = 3;
  private useClaudeModels: boolean = true;
  private logger: ExecutionLogger | undefined;
  private permissionFailedActions: Set<string> = new Set();
  private useLLMPrompts: boolean = true; 
  private batchManager: BatchManager;
  private historyManager: TestingHistoryManager;
  private tokenDetector: TokenActionDetector;
  private skippedActions: SkippedActionInfo[] = [];
  private currentExecutionState: {
    platform: string;
    batchNumber: number;
    actionRange: string;
    currentActionIndex: number;
    executedActions: Array<{
      actionId: string;
      actionTitle: string;
      prompt: string;
      output: string;
      success: boolean;
      extractedData?: any;
    }>;
    availableResources: {[key: string]: string[]};
    startTime: number;
  } | null = null;
  private sessionStartTime: number = 0;
  private lastCheckpointTime: number = 0;
  private checkpointInterval: number = 30000; 
  private isShuttingDown: boolean = false;

  constructor(picaSdkSecretKey: string, openAIApiKey: string) {
    this.picaApiService = new PicaApiService(picaSdkSecretKey);
    this.agentService = new EnhancedAgentService(picaSdkSecretKey, openAIApiKey);
    this.knowledgeRefiner = new KnowledgeRefiner(openAIApiKey);
    this.contextManager = new EnhancedContextManager(this.useClaudeModels);
    this.dependencyAnalyzer = new EnhancedDependencyAnalyzer(this.useClaudeModels);
    this.promptGenerator = new EnhancedPromptGenerator(this.useClaudeModels);
    this.batchManager = new BatchManager(this.useClaudeModels);
    this.historyManager = new TestingHistoryManager();
    this.tokenDetector = new TokenActionDetector();
    this.skippedActions = [];
  }

  public async start(): Promise<void> {
    tokenTracker.reset();
    this.sessionStartTime = Date.now();
    
    try {
      const connections = await this.picaApiService.getAllConnectionDefinitions();
      if (!connections || connections.length === 0) {
        console.log("No connection definitions found. Exiting.");
        return;
      }

      const selectedConnection = await this.promptForConnectionSelection(connections);
      if (!selectedConnection) return;

      console.log(chalk.bold(`\n📊 Selected platform: ${selectedConnection.name}`));
      
      this.historyManager.createSessionCheckpoint(selectedConnection.name, {
        sessionId: `${selectedConnection.name}_${new Date().toISOString().split('T')[0]}`,
        startTime: this.sessionStartTime,
        platform: selectedConnection.name,
        status: 'active'
      });
      
      await this.testPlatform(selectedConnection);

    } catch (error) {
      console.error("\n💥 An unexpected error occurred in the orchestrator:", error);
      
      if (this.currentExecutionState) {
        this.historyManager.saveGracefulInterrupt(
          this.currentExecutionState.platform,
          `Unexpected error: ${error}`,
          { error: String(error), timestamp: new Date().toISOString() }
        );
      }
    } finally {
      if (!this.isShuttingDown) {
        await this.gracefulShutdown();
      }
      
      tokenTracker.printSummary();
      
      if (this.logger) {
        this.logger.generateSummaryReport();
      }
      rl.close();
      console.log("\n👋 Enhanced test suite finished.");
    }
  }

  private async promptForConnectionSelection(connections: ConnectionDefinition[]): Promise<ConnectionDefinition | null> {
    while (true) {
      PlatformSelector.showSelectionMenu();
      const choice = await rl.question('\n➡️ Choose option (1-3): ');
      
      switch (choice) {
        case '1':
          const searchResult = await this.handleSearchMode(connections);
          if (searchResult) return searchResult;
          break;
          
        case '2':
          const browseResult = await this.handleBrowseMode(connections);
          if (browseResult) return browseResult;
          break;
          
        case '3':
          console.log(chalk.cyan('\n👋 Goodbye!'));
          return null;
          
        default:
          console.log(chalk.red('Invalid choice. Please select 1, 2, or 3.'));
      }
    }
  }

  private async handleSearchMode(connections: ConnectionDefinition[]): Promise<ConnectionDefinition | null> {
    while (true) {
      const searchTerm = await rl.question('\n🔍 Enter platform name or keyword (or type "back" to return): ');
      
      if (searchTerm.toLowerCase() === 'back') {
        return null;
      }
      
      const filteredPlatforms = PlatformSelector.filterPlatforms(connections, searchTerm);
      
      if (filteredPlatforms.length === 0) {
        console.log(chalk.red('No platforms found matching your search.'));
        
        const suggestions = PlatformSelector.suggestSimilarPlatforms(connections, searchTerm);
        if (suggestions.length > 0) {
          console.log(chalk.yellow('\n💡 Did you mean one of these?'));
          PlatformSelector.displayFilteredResults(suggestions);
        }
        
        console.log(chalk.gray('\nTip: Try different keywords or use "back" to return to the main menu.'));
        continue;
      }
      
      PlatformSelector.displayFilteredResults(filteredPlatforms);
      
      const selection = await rl.question('\n➡️ Select platform by number (or type "search" for new search, "back" to return): ');
      
      if (selection.toLowerCase() === 'search') {
        continue;
      }
      
      if (selection.toLowerCase() === 'back') {
        return null;
      }
      
      if (PlatformSelector.isValidSelection(selection, filteredPlatforms.length)) {
        const selectedIndex = parseInt(selection);
        const selectedConnection = PlatformSelector.getConnectionByDisplayIndex(filteredPlatforms, selectedIndex);
        
        if (selectedConnection) {
          return selectedConnection;
        }
      }
      
      console.log(chalk.red('Invalid selection. Please try again.'));
    }
  }

  private async handleBrowseMode(connections: ConnectionDefinition[]): Promise<ConnectionDefinition | null> {
    while (true) {
      PlatformSelector.displayAllPlatforms(connections);
      
      const choice = await rl.question('\n➡️ Select platform by number (or type "back" to return): ');
      
      if (choice.toLowerCase() === 'back') {
        return null;
      }
      
      if (PlatformSelector.isValidSelection(choice, connections.length)) {
        const selectedIndex = parseInt(choice) - 1;
        return connections[selectedIndex];
      }
      
      console.log(chalk.red('Invalid selection. Please try again.'));
    }
  }

  private async testPlatform(connection: ConnectionDefinition): Promise<void> {
  let modelDefinitions = await this.picaApiService.getModelDefinitions(connection._id);
  modelDefinitions = modelDefinitions.filter(action => action.supported !== false);
  
  console.log(chalk.bold(`\n📋 Found ${modelDefinitions.length} supported actions for ${connection.name}`));
  
  if (!this.logger) {
    this.logger = new ExecutionLogger(connection.name);
    this.agentService.setLogger(this.logger);
  }

  this.historyManager.displayHistory(connection.name);

  const { selection, strategy } = await this.getBatchSelection(connection.name, modelDefinitions);
  
  if (this.logger) {
    const range = this.formatRange(selection, strategy.selectedActions.length);
    const estimatedBatches = Math.ceil(strategy.selectedActions.length / (selection.batchSize || 75));
    this.logger.setBatchMetadata(strategy.batchNumber, range, estimatedBatches);
    console.log(chalk.blue(`   📊 Logger configured for batch ${strategy.batchNumber}: ${range}`));
  }
  
  if (strategy.needsContext) {
    console.log(chalk.blue(`\n🔄 Loading context from ${strategy.requiredBatches.length} previous batches...`));
    const loadedContext = await this.batchManager.loadRequiredContext(connection.name, strategy.requiredBatches);
    this.contextManager = new EnhancedContextManager(this.useClaudeModels);
    this.contextManager.mergeContext(loadedContext);
  } else {
    this.contextManager.reset();
  }

  const startTime = Date.now();
  const results = await this.executeBatch(connection, strategy, modelDefinitions);
  const duration = Date.now() - startTime;

  const context = this.contextManager.getContext();
  const range = this.formatRange(selection, strategy.selectedActions.length);
  
  const refinedKnowledge = new Map<string, string>();
  const promptPatterns = new Map<string, any>();
  
  results.forEach(result => {
    if (result.finalKnowledge && result.finalKnowledge !== result.originalKnowledge) {
      refinedKnowledge.set(result.actionId || result.actionTitle, result.finalKnowledge);
    }
    if (result.strategyUsed) {
      promptPatterns.set(result.actionId || result.actionTitle, result.strategyUsed);
    }
  });
  
  this.batchManager.saveBatchResults(
    connection.name,
    strategy.batchNumber,
    range,
    results,
    context,
    duration,
    refinedKnowledge,
    promptPatterns
  );
  
  console.log(chalk.bold.green(`\n✅ Batch ${strategy.batchNumber} completed in ${this.formatDuration(duration)}`));
}

private async getBatchSelection(platform: string, allActions: ModelDefinition[]): Promise<{ selection: ActionSelection; strategy: BatchStrategy }> {
  const interruptedBatch = this.historyManager.hasInterruptedBatch(platform);
  
  if (interruptedBatch.canResume) {
    console.log(chalk.yellow(`\n⚠️ Found interrupted batch ${interruptedBatch.batchInfo.batchNumber}`));
    console.log(chalk.yellow(`   Last executed action: ${interruptedBatch.batchInfo.interruptedAt}`));
    console.log(chalk.yellow(`   Range: ${interruptedBatch.batchInfo.range}`));
    console.log(chalk.yellow(`   Progress: ${interruptedBatch.batchInfo.successCount}/${interruptedBatch.batchInfo.actionCount} actions completed`));
    
    console.log(chalk.bold.cyan('\n📋 Select actions to test:'));
    console.log('1. Resume from interruption 📍');
    console.log('2. Test all actions (fresh start)');
    console.log('3. Continue from last batch');
    console.log('4. Test specific range (e.g., 51-100)');
    console.log('5. Re-run failed actions 🔄');
    console.log('6. Custom selection');

    const choice = await rl.question('\n➡️ Choose option (1-6): ');
    
    let selection: ActionSelection;
    
    switch (choice) {
      case '1':
        selection = { type: 'continue' }; 
        break;
        case '2':
          const defaultBatchSize = 75;
          selection = { type: 'dependency-ordered', batchSize: defaultBatchSize };
          break;
      case '3':
        selection = { type: 'continue' };
        break;
      case '4':
        const range = await rl.question('Enter range (e.g., 51-100): ');
        const [start, end] = range.split('-').map(n => parseInt(n.trim()) - 1);
        selection = { type: 'range', startIndex: start, endIndex: end };
        break;
      case '5':
        this.batchManager.displayFailedActionsSummary(platform, allActions);
        const failedCount = this.batchManager.getFailedActionIds(platform).length;
        if (failedCount === 0) {
          console.log(chalk.yellow('No failed actions found. Using dependency-ordered execution instead.'));
          const defaultBatchSize = 75;
          selection = { type: 'dependency-ordered', batchSize: defaultBatchSize };
        } else {
          const confirm = await rl.question(`\n➡️ Re-run ${failedCount} failed actions? (y/n): `);
          if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
            selection = { type: 'failed', platform };
          } else {
            const defaultBatchSize = 75;
            selection = { type: 'dependency-ordered', batchSize: defaultBatchSize };
          }
        }
        break;
      case '6':
        selection = await this.getCustomSelection(allActions);
        break;
      default:
        console.log('Invalid choice. Resuming from interruption.');
        selection = { type: 'continue' };
    }
    
    const strategy = await this.batchManager.createStrategy(selection, platform, allActions);
    
    if (strategy.isResume) {
      console.log(chalk.green(`\n✅ Will resume batch ${strategy.resumeContext.batchNumber} with ${strategy.selectedActions.length} remaining actions`));
    }
    
    if (strategy.missingDependencies.length > 0) {
      console.log(chalk.yellow(`\n⚠️ Warning: ${strategy.missingDependencies.length} dependencies missing from previous batches`));
      console.log(chalk.gray('Context will be loaded automatically to resolve dependencies.'));
    }

    return { selection, strategy };
  } else {
    console.log(chalk.bold.cyan('\n Select actions to test:'));
    console.log('1. Run all actions');
    console.log('2. Continue from last batch');
    console.log('3. Test specific range (e.g., 51-100)');
    console.log('4. Re-run failed actions');
    console.log('5. Custom selection');

    const choice = await rl.question('\n➡️ Choose option (1-5): ');
    
    let selection: ActionSelection;
    
    switch (choice) {
      case '1':
        const batchSize = await this.getBatchSizeFromUser();
        selection = { type: 'dependency-ordered', batchSize };
        
        console.log(chalk.blue('\n🔄 Analyzing dependencies and creating execution plan...'));
        break;
      case '2':
        selection = { type: 'continue' };
        break;
      case '3':
        const range = await rl.question('Enter range (e.g., 51-100): ');
        const [start, end] = range.split('-').map(n => parseInt(n.trim()) - 1);
        selection = { type: 'range', startIndex: start, endIndex: end };
        break;
      case '4':
        this.batchManager.displayFailedActionsSummary(platform, allActions);
        const failedCount = this.batchManager.getFailedActionIds(platform).length;
        if (failedCount === 0) {
          console.log(chalk.yellow('No failed actions found. Using dependency-ordered execution instead.'));
          const defaultBatchSize = 75;
          selection = { type: 'dependency-ordered', batchSize: defaultBatchSize };
        } else {
          const confirmFailed = await rl.question(`\n➡️ Re-run ${failedCount} failed actions? (y/n): `);
          if (confirmFailed.toLowerCase() === 'y' || confirmFailed.toLowerCase() === 'yes') {
            selection = { type: 'failed', platform };
          } else {
            const defaultBatchSize = 75;
            selection = { type: 'dependency-ordered', batchSize: defaultBatchSize };
          }
        }
        break;
      case '5':
        selection = await this.getCustomSelection(allActions);
        break;
      default:
        console.log('Invalid choice. Using dependency-ordered execution.');
        const defaultBatchSize = 75;
        selection = { type: 'dependency-ordered', batchSize: defaultBatchSize };
    }

    const strategy = await this.batchManager.createStrategy(selection, platform, allActions);
    
    if (strategy.missingDependencies.length > 0) {
      console.log(chalk.yellow(`\n⚠️ Warning: ${strategy.missingDependencies.length} dependencies missing from previous batches`));
      console.log(chalk.gray('Context will be loaded automatically to resolve dependencies.'));
    }

    return { selection, strategy };
  }
}

  private formatRange(selection: ActionSelection, actionCount: number): string {
    switch (selection.type) {
      case 'dependency-ordered': return `1-${actionCount}`;
      case 'continue': return `${(selection.startIndex || 0) + 1}-${(selection.startIndex || 0) + actionCount}`;
      case 'range': return `${(selection.startIndex || 0) + 1}-${(selection.endIndex || 0) + 1}`;
      default: return `custom-${actionCount}`;
    }
  }

  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((ms % (1000 * 60)) / 1000);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  private async getCustomSelection(allActions: ModelDefinition[]): Promise<ActionSelection> {
    console.log(chalk.bold.cyan('\n🎯 Custom Action Selection:'));
    console.log('1. Search by keyword');
    console.log('2. Select by action numbers');
    console.log('3. Select by action names');
    
    const method = await rl.question('\n➡️ Choose selection method (1-3): ');
    
    switch (method) {
      case '1':
        return await this.selectByKeyword(allActions);
      case '2':
        return await this.selectByNumbers(allActions);
      case '3':
        return await this.selectByNames(allActions);
      default:
        console.log(chalk.yellow('Invalid choice. Using keyword search.'));
        return await this.selectByKeyword(allActions);
    }
  }

  private async getBatchSizeFromUser(): Promise<number> {
    console.log(chalk.bold.cyan('\n⚙️ Batch Size Configuration:'));
    console.log(chalk.gray('Batch size determines how many actions are executed together.'));
    console.log(chalk.gray('Larger batches = faster execution, smaller batches = better resource management.'));
    console.log(chalk.gray('Recommended: 50-100 for most platforms, 25-50 for large platforms (1000+ actions).'));
    
    while (true) {
      const input = await rl.question('\n➡️ Enter batch size (1-200, default 75): ');
      
      if (!input || input.trim() === '') {
        console.log(chalk.green('Using default batch size: 75'));
        return 75;
      }
      
      const batchSize = parseInt(input.trim());
      
      if (isNaN(batchSize)) {
        console.log(chalk.red('Invalid input. Please enter a number.'));
        continue;
      }
      
      if (batchSize < 1 || batchSize > 200) {
        console.log(chalk.red('Batch size must be between 1 and 200.'));
        continue;
      }
      
      if (batchSize > 150) {
        console.log(chalk.yellow('⚠️ Large batch size may cause memory issues with complex actions.'));
      } else if (batchSize < 10) {
        console.log(chalk.yellow('⚠️ Small batch size may result in slower execution.'));
      }
      
      console.log(chalk.green(`✅ Batch size set to: ${batchSize}`));
      return batchSize;
    }
  }

  private async selectByKeyword(allActions: ModelDefinition[]): Promise<ActionSelection> {
    const keyword = await rl.question('\n🔍 Enter keyword to search actions: ');
    const filteredActions = allActions.filter(action =>
      action.title.toLowerCase().includes(keyword.toLowerCase()) ||
      action.modelName.toLowerCase().includes(keyword.toLowerCase()) ||
      action.actionName.toLowerCase().includes(keyword.toLowerCase())
    );

    if (filteredActions.length === 0) {
      console.log(chalk.red(`No actions found matching "${keyword}". Using dependency-ordered execution.`));
      return { type: 'dependency-ordered', batchSize: 75 };
    }

    console.log(chalk.green(`\n✅ Found ${filteredActions.length} actions matching "${keyword}":`));
    filteredActions.forEach((action, index) => {
      console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${action.title} (${action.modelName})`);
    });

    const confirm = await rl.question('\n➡️ Use these actions? (y/n): ');
    if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
      return {
        type: 'custom',
        actionIds: filteredActions.map(a => a._id)
      };
    } else {
      console.log(chalk.yellow('Selection cancelled. Using dependency-ordered execution.'));
      return { type: 'dependency-ordered', batchSize: 75 };
    }
  }

  private async selectByNumbers(allActions: ModelDefinition[]): Promise<ActionSelection> {
    console.log(chalk.cyan('\n📋 Available Actions:'));
    allActions.forEach((action, index) => {
      console.log(`${chalk.cyan(String(index + 1).padStart(3))}. ${action.title} (${action.modelName})`);
    });

    const numbersStr = await rl.question('\n➡️ Enter action numbers (comma-separated, e.g., 1,5,10-15): ');
    const actionIds: string[] = [];
    
    const parts = numbersStr.split(',').map(p => p.trim());
    
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim()));
        for (let i = start; i <= end; i++) {
          if (i >= 1 && i <= allActions.length) {
            actionIds.push(allActions[i - 1]._id);
          }
        }
      } else {
        const num = parseInt(part);
        if (num >= 1 && num <= allActions.length) {
          actionIds.push(allActions[num - 1]._id);
        }
      }
    }

    if (actionIds.length === 0) {
      console.log(chalk.red('No valid actions selected. Using dependency-ordered execution.'));
      return { type: 'dependency-ordered', batchSize: 75 };
    }

    console.log(chalk.green(`\n✅ Selected ${actionIds.length} actions`));
    return {
      type: 'custom',
      actionIds
    };
  }

  private async selectByNames(allActions: ModelDefinition[]): Promise<ActionSelection> {
    console.log(chalk.cyan('\n📋 Available Actions:'));
    allActions.forEach((action, index) => {
      console.log(`  ${action.title} (${action.modelName})`);
    });

    const namesStr = await rl.question('\n➡️ Enter action names (comma-separated, partial matches allowed): ');
    const namePatterns = namesStr.split(',').map(p => p.trim().toLowerCase());
    
    const selectedActions = allActions.filter(action =>
      namePatterns.some(pattern =>
        action.title.toLowerCase().includes(pattern) ||
        action.modelName.toLowerCase().includes(pattern)
      )
    );

    if (selectedActions.length === 0) {
      console.log(chalk.red('No actions matched the provided names. Using dependency-ordered execution.'));
      return { type: 'dependency-ordered', batchSize: 75 };
    }

    console.log(chalk.green(`\n✅ Selected ${selectedActions.length} actions:`));
    selectedActions.forEach(action => {
      console.log(`  • ${action.title} (${action.modelName})`);
    });

    const confirm = await rl.question('\n➡️ Use these actions? (y/n): ');
    if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
      return {
        type: 'custom',
        actionIds: selectedActions.map(a => a._id)
      };
    } else {
      console.log(chalk.yellow('Selection cancelled. Using dependency-ordered execution.'));
      return { type: 'dependency-ordered', batchSize: 75 };
    }
  }

private async executeBatch(
  connection: ConnectionDefinition,
  strategy: BatchStrategy,
  allActions: ModelDefinition[]
): Promise<EnhancedActionResult[]> {
  const results: EnhancedActionResult[] = [];
  const failedActions: Array<{action: ModelDefinition, result: EnhancedActionResult, reason: string}> = [];

  this.currentExecutionState = {
    platform: connection.name,
    batchNumber: strategy.batchNumber,
    actionRange: this.formatRange({ type: 'dependency-ordered', batchSize: 75 }, strategy.selectedActions.length),
    currentActionIndex: 0,
    executedActions: [],
    availableResources: {},
    startTime: Date.now()
  };

  console.log(chalk.bold.inverse(`\n\n🔄 BATCH ${strategy.batchNumber}: Executing ${strategy.selectedActions.length} actions 🔄`));

  console.log(chalk.cyan("\n🧩 Analyzing action dependencies..."));
  
  let dependencyGraph;
  if (strategy.dependencyGraph) {
    console.log(chalk.green("   ✅ Using cached dependency graph from batch analysis"));
    dependencyGraph = strategy.dependencyGraph;
  } else {
    console.log(chalk.blue("   🔄 No cached graph found, performing fresh analysis..."));
    dependencyGraph = await this.dependencyAnalyzer.analyzeDependencies(
      strategy.selectedActions,
      connection.name
    );
  }

  const sortedActions = this.dependencyAnalyzer.getSortedActions(dependencyGraph, strategy.selectedActions);
  this.displayExecutionPlan(sortedActions, dependencyGraph);

  console.log(chalk.bold.inverse("\n\n🔄 PASS 1: Initial Execution with Dependency Order 🔄"));

  for (let i = 0; i < sortedActions.length; i++) {
    const action = sortedActions[i];
    
    if (this.currentExecutionState) {
      this.currentExecutionState.currentActionIndex = i;
    }
    
    const actionMetadata = this.dependencyAnalyzer.getActionMetadata(action._id, dependencyGraph);

    if (!action.knowledge || action.knowledge.trim() === "") {
      console.log(chalk.gray(`\n⏭️ Skipping "${action.title}" - No knowledge provided.`));
      const skippedResult = {
        actionTitle: action.title,
        modelName: action.modelName,
        success: false,
        error: "Skipped - No knowledge",
        originalKnowledge: "",
        attempts: 0,
        passNumber: 1,
        dependenciesMet: true
      };
      results.push(skippedResult);
      
      this.updateExecutionState(action, "Skipped - No knowledge provided", skippedResult, false);
      continue;
    }

    console.log(chalk.bold.blue(`\n🎯 Testing: "${action.title}" (${action.modelName})`));
    if (results.length > 0 && results.length % 5 === 0) {
      try {
        if (this.logger) {
          this.logger.generateSummaryReport();
        }
      } catch (err) {
        console.error('Error generating intermediate summary:', err);
      }
    }
    if (actionMetadata) {
      console.log(chalk.gray(`   Priority: ${actionMetadata.priority}, Optional: ${actionMetadata.isOptional}`));
    }
    
    let actionPrompt = "Action execution";
    
    const result = await this.executeActionWithSmartRetries(action, 1, dependencyGraph, this.maxRetriesPerAction);
    results.push(result);

    this.updateExecutionState(action, actionPrompt, result, result.success);
    
    this.contextManager.updateContext(action, result, result.extractedData);

    if (!result.success) {
      if (result.isPermissionError) {
        this.permissionFailedActions.add(action._id);
        console.log(chalk.red(`   ⛔ Permission error - will not retry`));
      } else {
        failedActions.push({ action, result, reason: "execution_failed" });
      }
    }
  }

  if (failedActions.length > 0) {
    const retryableFailures = failedActions.filter(
      f => !this.permissionFailedActions.has(f.action._id)
    );

    if (retryableFailures.length > 0) {
      console.log(chalk.bold.inverse(
        `\n\n🔄 PASS 2: Retrying ${retryableFailures.length} Failed Actions` +
        `${failedActions.length - retryableFailures.length > 0 ?
          ` (${failedActions.length - retryableFailures.length} skipped due to permissions)` :
          ''} 🔄`
      ));

      for (const { action, result: pass1Result } of retryableFailures) {
        console.log(chalk.bold.yellow(`\n🔁 Retrying: "${action.title}"`));
        console.log(chalk.gray(`   Previous failure: ${pass1Result.error}`));

        const knowledgeToUse = pass1Result.finalKnowledge || action.knowledge;
        const enhancedAction = { ...action, knowledge: knowledgeToUse };

        const pass2Result = await this.executeActionWithSmartRetries(
          enhancedAction,
          2,
          dependencyGraph,
          1,
          pass1Result.error
        );

        const originalIndex = results.findIndex(r =>
          r.actionTitle === action.title && r.modelName === action.modelName
        );
        if (originalIndex >= 0) {
          results[originalIndex] = {
            ...pass2Result,
            attempts: pass1Result.attempts + pass2Result.attempts,
            originalKnowledge: action.knowledge,
            passNumber: 2
          };
        }

        if (pass2Result.success) {
          this.contextManager.updateContext(enhancedAction, pass2Result, pass2Result.extractedData);
        }
      }
    } else {
      console.log(chalk.yellow.inverse("\n\n⚠️ All failures were due to permission errors - skipping Pass 2"));
    }
  }

  try {
    this.saveModifiedKnowledge(connection.name, results);
    this.displayEnhancedSummary(connection, results, dependencyGraph);
    if (this.logger) {
      this.logger.generateSummaryReport();
    }
  } catch (error) {
    console.error(chalk.red("💥 Error during platform testing:"), error);
    this.displayEnhancedSummary(connection, results, dependencyGraph);
    if (this.logger) {
      this.logger.generateSummaryReport();
    }
    throw error;
  }
  
  return results;
}


  public async handleInterrupt(): Promise<void> {
    console.log(chalk.blue("\n🛑 Shutting down and saving state..."));
    
    try {
      if (this.currentExecutionState) {
        await this.saveInterruptState();
      }
      
      await this.saveAllPendingKnowledge();
      
      if (this.logger) {
        this.logger.generateSummaryReport();
      }
      
      console.log(chalk.green("✅ Interrupt state saved successfully"));
    } catch (error) {
      console.error(chalk.red("❌ Error saving interrupt state:"), error);
    }
  }

  public cleanup(): void {
    try {
      if (this.agentService) {
        this.agentService.close();
      }
      console.log(chalk.gray("🧹 Resources cleaned up"));
    } catch (error) {
      console.error(chalk.red("❌ Error during cleanup:"), error);
    }
  }

  private async gracefulShutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    try {
      if (this.currentExecutionState) {
        await this.saveEnhancedInterruptState();
        
        this.historyManager.cleanupSessionCheckpoint(this.currentExecutionState.platform);
      }
      this.cleanup();
      console.log(chalk.green("   ✅ Graceful shutdown completed"));
    } catch (error) {
      console.error(chalk.red("   ❌ Error during graceful shutdown:"), error);
    }
  }

  private async saveEnhancedInterruptState(): Promise<void> {
    if (!this.currentExecutionState) return;
    
    try {
      const context = this.contextManager.getContext();
      const contextPersistence = new (require('./context_persistence_manager').ContextPersistenceManager)();
      contextPersistence.enhancedSaveInterruptState(
        this.currentExecutionState.platform,
        this.currentExecutionState.batchNumber,
        this.currentExecutionState,
        context
      );
      
      this.historyManager.saveGracefulInterrupt(
        this.currentExecutionState.platform,
        'Graceful shutdown',
        {
          progress: {
            currentBatch: this.currentExecutionState.batchNumber,
            totalBatches: 1,
            currentAction: this.currentExecutionState.currentActionIndex,
            totalActions: this.currentExecutionState.executedActions.length,
            completedActions: this.currentExecutionState.executedActions.filter(a => a.success).length,
            elapsedTime: Date.now() - this.currentExecutionState.startTime
          }
        }
      );
      
      console.log(chalk.green("   ✅ Enhanced interrupt state saved"));
    } catch (error) {
      console.error(chalk.red("   ❌ Failed to save enhanced interrupt state:"), error);
    }
  }
  
  private async saveInterruptState(): Promise<void> {
    if (!this.currentExecutionState) return;
    
    const contextDir = path.join(process.cwd(), 'logs', 'contexts');
    if (!fs.existsSync(contextDir)) {
      fs.mkdirSync(contextDir, { recursive: true });
    }

    const interruptFile = path.join(contextDir, 
      `${this.currentExecutionState.platform}_batch_${this.currentExecutionState.batchNumber}_interrupt.json`);
    
    const minimalContext = {
      platform: this.currentExecutionState.platform,
      batchNumber: this.currentExecutionState.batchNumber,
      actionRange: this.currentExecutionState.actionRange,
      interruptedAt: this.currentExecutionState.currentActionIndex,
      timestamp: new Date().toISOString(),
      executedActions: this.currentExecutionState.executedActions.map(action => ({
        ...action,
        prompt: action.prompt.substring(0, 500), 
        output: action.output.substring(0, 500)
      })),
      availableResources: this.currentExecutionState.availableResources,
      duration: Date.now() - this.currentExecutionState.startTime
    };

    fs.writeFileSync(interruptFile, JSON.stringify(minimalContext, null, 2));
    console.log(chalk.green(`   ✅ Saved interrupt context to ${interruptFile}`));
    
    this.historyManager.saveInterruptedBatch(this.currentExecutionState);
  }
  
  private async saveAllPendingKnowledge(): Promise<void> {
    try {
      if (this.knowledgeRefiner && typeof this.knowledgeRefiner.saveAllPendingKnowledge === 'function') {
        this.knowledgeRefiner.saveAllPendingKnowledge();
      }
    } catch (error) {
      console.error(chalk.red("❌ Error saving pending knowledge:"), error);
    }
  }
  
  private updateExecutionState(action: ModelDefinition, prompt: string, result: any, success: boolean): void {
    if (!this.currentExecutionState) return;
    
    this.currentExecutionState.executedActions.push({
      actionId: action._id,
      actionTitle: action.title,
      prompt: prompt,
      output: result.output || result.error || "",
      success: success,
      extractedData: result.extractedData
    });
    
    if (result.extractedData?.ids) {
      Object.entries(result.extractedData.ids).forEach(([key, value]) => {
        if (!this.currentExecutionState!.availableResources[key]) {
          this.currentExecutionState!.availableResources[key] = [];
        }
        if (Array.isArray(value)) {
          this.currentExecutionState!.availableResources[key].push(...value);
        } else {
          this.currentExecutionState!.availableResources[key].push(value as string);
        }
      });
    }
  }
  private checkDependencies(
    actionId: string, 
    dependencyGraph: any, 
    results: EnhancedActionResult[]
  ): boolean {
    const dependencies = this.dependencyAnalyzer.getActionDependencies(actionId, dependencyGraph);
    if (dependencies.length === 0) return true;
    
    for (const depId of dependencies) {
      const depResult = results.find(r => {
        const depAction = dependencyGraph.nodes.find((n: any) => n.id === depId);
        return depAction && 
               r.actionTitle === depAction.actionName && 
               r.modelName === depAction.modelName;
      });
      
      if (!depResult || !depResult.success) {
        return false;
      }
    }
    
    return true;
  }

  private saveModifiedKnowledge(platformName: string, results: EnhancedActionResult[]): void {
    const modifiedKnowledgeActions = results.filter(r => {
      return r.finalKnowledge && 
             r.finalKnowledge !== r.originalKnowledge && 
             !r.error?.includes("Skipped");
    });
    
    if (modifiedKnowledgeActions.length === 0) {
      console.log(chalk.gray('\nNo modified knowledge to save.'));
      return;
    }
    
    const knowledgeDir = path.join(process.cwd(), 'knowledge', platformName);
    if (!fs.existsSync(knowledgeDir)) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
    }
    
    console.log(chalk.blue(`\n💾 Saving ${modifiedKnowledgeActions.length} refined knowledge files...`));
    
    modifiedKnowledgeActions.forEach(result => {
      const actionId = (result.actionId || 'unknown')
        .replace(/::/g, '_')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/_{2,}/g, '_');
      
      const prefix = result.success ? '' : 'failed_';
      const filename = `${prefix}${actionId}.md`;
      const filepath = path.join(knowledgeDir, filename);
      
      const content = `# ${result.actionTitle}\n\n## Model: ${result.modelName}\n\n${result.finalKnowledge}`;
      
      try {
        fs.writeFileSync(filepath, content);
        const statusColor = result.success ? chalk.green : chalk.red;
        const statusText = result.success ? 'Success' : 'Failed';
        console.log(statusColor(`   ✓ Saved ${statusText}: ${filename}`));
      } catch (error) {
        console.error(chalk.red(`   ❌ Failed to save ${filename}: ${error}`));
      }
    });
  }


  private validateActionPath(
  action: ModelDefinition, 
  context: ExecutionContext
): { canExecute: boolean; reason?: string } {
  const validation = PathParameterResolver.validateRequiredParameters(
    action.path, 
    context
  );
  
  if (!validation.isValid) {
    return {
      canExecute: false,
      reason: `Missing required parameters: ${validation.missingParams.join(', ')}`
    };
  }
  
  return { canExecute: true };
}

  private async executeActionWithSmartRetries(
  action: ModelDefinition,
  passNumber: number,
  dependencyGraph: any,
  maxAttempts: number,
  previousError?: string,
): Promise<EnhancedActionResult> {
  const tokenDetectionResult = this.tokenDetector.detectTokenAction(action);
  if (tokenDetectionResult.shouldSkip) {
    console.log(chalk.yellow(`   🚫 SKIPPED: Token action detected - ${tokenDetectionResult.reason}`));
    this.tokenDetector.logDetectionResult(action, tokenDetectionResult);
    
    const skippedInfo: SkippedActionInfo = {
      actionId: action._id,
      actionTitle: action.title,
      modelName: action.modelName,
      platform: action.connectionPlatform,
      reason: tokenDetectionResult.reason,
      category: tokenDetectionResult.category,
      matchedKeywords: tokenDetectionResult.matchedKeywords,
      timestamp: new Date().toISOString()
    };
    
    this.skippedActions.push(skippedInfo);
    
    return {
      success: false,
      error: `Skipped - ${tokenDetectionResult.reason}`,
      originalKnowledge: action.knowledge,
      finalKnowledge: action.knowledge,
      attempts: 0,
      actionTitle: action.title,
      modelName: action.modelName,
      extractedData: {},
      passNumber,
      strategyUsed: 'skipped',
      dependenciesMet: true,
      analysisReason: tokenDetectionResult.reason,
      actionId: action._id,
      isSkipped: true,
      skipReason: tokenDetectionResult.reason,
      skipCategory: tokenDetectionResult.category
    };
  }

  let currentKnowledge = action.knowledge;
  let attempts = 0;
  let lastError: string | undefined;
  let extractedData: any;
  let strategyUsed: string | undefined;
  let lastAgentResponse: string | undefined;

  const currentContext = this.contextManager.getContext();
  const dependenciesMet = this.checkDependencies(action._id, dependencyGraph, []);
  const pathValidation = this.validateActionPath(action, currentContext);

  if (!dependenciesMet && attempts === 1) {
    console.log(chalk.yellow(`   Dependencies not yet met, but will try anyway`));
  }

  if (!pathValidation.canExecute && attempts === 1) {
    console.log(chalk.yellow(`   ${pathValidation.reason}, but will try anyway`));
  }
  const actionMetadata = this.dependencyAnalyzer.getActionMetadata(action._id, dependencyGraph);
  if (actionMetadata && actionMetadata.requiresIds.length > 0) {
    console.log(chalk.blue(`   Required IDs: ${actionMetadata.requiresIds.join(', ')}`));
    
    const missingIds = actionMetadata.requiresIds.filter(reqId => 
      !currentContext.availableIds.has(reqId) || 
      currentContext.availableIds.get(reqId)?.length === 0
    );
    
    if (missingIds.length > 0) {
      console.log(chalk.yellow(`   ⚠️ Missing required IDs: ${missingIds.join(', ')}`));
    }
  }
  while (attempts < maxAttempts) {
    attempts++;
    console.log(chalk.blue(`   Attempt ${attempts}/${maxAttempts}...`));
    const context = this.contextManager.getContext();
    
    let prompt: string;
    let strategy: any;
    let confidence = 0.8;
    let reasoning = "";
    
    if (this.useLLMPrompts && attempts === 1) {
      console.log(chalk.cyan(`   🤖 Using LLM-based human prompt generation...`));
      try {
        const llmResult = await this.promptGenerator.generateHumanLikePrompt(
          { ...action, knowledge: currentKnowledge },
          context,
          dependencyGraph,
          attempts,
          previousError || lastError,
          await this.picaApiService.getModelDefinitions(action.connectionPlatform)
        );
        
        prompt = llmResult.prompt;
        strategy = llmResult.strategy;
        confidence = llmResult.confidence;
        reasoning = llmResult.reasoning;
        
        console.log(chalk.green(`   ✅ Generated human-like prompt (${confidence}% confidence)`));
        console.log(chalk.gray(`   💭 ${reasoning}`));
        
      } catch (error) {
        console.log(chalk.yellow(`   ⚠️ LLM prompt generation failed, using fallback...`));
        const resourceName = action.title.toLowerCase();
        prompt = `Please help me ${action.actionName.toLowerCase()} a ${resourceName} using ${action.connectionPlatform}.\n\n${action.knowledge}\n\nUse Action ID: ${action._id}`;
        strategy = { tone: 'technical', emphasis: ['execute action'], examples: false, contextLevel: 'minimal' };
      }
    } else {
      try {
        const llmResult = await this.promptGenerator.generateHumanLikePrompt(
          { ...action, knowledge: currentKnowledge },
          context,
          dependencyGraph,
          attempts,
          previousError || lastError,
          await this.picaApiService.getModelDefinitions(action.connectionPlatform)
        );
        
        prompt = llmResult.prompt;
        strategy = llmResult.strategy;
        confidence = llmResult.confidence;
        reasoning = llmResult.reasoning;
      } catch (error) {
        const resourceName = action.title.toLowerCase();
        prompt = `Retry: ${action.actionName.toLowerCase()} a ${resourceName} using ${action.connectionPlatform}.\n\nPrevious error: ${previousError || lastError}\n\n${action.knowledge}\n\nUse Action ID: ${action._id}`;
        strategy = { tone: 'technical', emphasis: ['retry action', 'fix previous error'], examples: false, contextLevel: 'minimal' };
      }
    }
    
    strategyUsed = strategy.tone === 'conversation' ? 'conversational' : strategy.tone;
    
    const agentResult = await this.agentService.executeSmartTask(prompt, undefined, action, context, attempts, strategyUsed);

    if (!agentResult.success && agentResult.error) {
      const rateLimitDecision = await this.agentService.handleRateLimitIfNeeded(
        agentResult.error, 
        agentResult.output || '', 
        action
      );
      
      if (rateLimitDecision === 'abort') {
        console.log(chalk.red("   🛑 User chose to abort due to rate limit. Stopping execution."));
        throw new Error("Rate limit abort - User requested to stop execution");
      } else if (rateLimitDecision === 'retry') {
        console.log(chalk.blue("   🔄 Rate limit handled, retrying action..."));
      }
    }
   
    if (!agentResult.success && (agentResult.output?.includes('403') || agentResult.error?.includes('403'))) {
        console.log(chalk.yellow("   Directly detected a 403 error. Flagging as a definitive permission error."));
        agentResult.isPermissionError = true;
    }
    
    if (agentResult.success) {
      console.log(chalk.green(`   ✅ SUCCESS: ${agentResult.analysisReason || "Completed"}`));
      this.promptGenerator.recordPromptResult(action._id, prompt, true);
      
      if (agentResult.extractedData) {
        const fullResult: ActionResult = {
          ...agentResult,
          originalKnowledge: action.knowledge,
          attempts: attempts,
          actionTitle: action.title,
          modelName: action.modelName
        };
        this.contextManager.updateContext(action, fullResult, agentResult.extractedData);
      }
      
      return {
        success: true,
        output: agentResult.output,
        originalKnowledge: action.knowledge,
        finalKnowledge: currentKnowledge,
        attempts,
        actionTitle: action.title,
        modelName: action.modelName,
        extractedData: agentResult.extractedData,
        passNumber,
        strategyUsed,
        dependenciesMet: true,
        analysisReason: agentResult.analysisReason,
        actionId: action._id
      };
    } else if (agentResult.isPermissionError) {
      console.log(chalk.red(`   ⛔ Permission/Authentication error detected`));
      this.permissionFailedActions.add(action._id);
      return {
        success: false,
        error: agentResult.error || "Permission denied",
        originalKnowledge: action.knowledge,
        finalKnowledge: currentKnowledge,
        attempts,
        actionTitle: action.title,
        modelName: action.modelName,
        extractedData,
        passNumber,
        strategyUsed,
        dependenciesMet: true,
        analysisReason: agentResult.analysisReason,
        isPermissionError: true,
        actionId: action._id
      };
    }

    lastError = agentResult.error || "Unknown error";
    lastAgentResponse = agentResult.agentResponse;
    console.log(chalk.red(`   ❌ FAILED: ${agentResult.analysisReason || lastError}`));

    if (agentResult.isPermissionError) {
      this.permissionFailedActions.add(action._id);
      return {
        success: false,
        error: agentResult.error || "Permission denied",
        originalKnowledge: action.knowledge,
        finalKnowledge: currentKnowledge,
        attempts,
        actionTitle: action.title,
        modelName: action.modelName,
        extractedData,
        passNumber,
        strategyUsed,
        dependenciesMet: true,
        analysisReason: agentResult.analysisReason,
        isPermissionError: true,
        actionId: action._id
      };
    }

    this.promptGenerator.recordPromptResult(action._id, prompt, false);

    if (attempts < this.maxRetriesPerAction) {
      console.log(chalk.yellow("   💡 Refining approach..."));
      
      const refinement = await this.knowledgeRefiner.refineKnowledge(
        currentKnowledge,
        lastError,
        action,
        context,
        prompt,
        lastAgentResponse
      );

      if (refinement.knowledge && refinement.knowledge !== currentKnowledge) {
        this.displayKnowledgeDiff(currentKnowledge, refinement.knowledge);
        
        
        currentKnowledge = refinement.knowledge;
      }
    }
  }

  return {
    success: false,
    error: lastError,
    originalKnowledge: action.knowledge,
    finalKnowledge: currentKnowledge,
    attempts,
    actionTitle: action.title,
    modelName: action.modelName,
    extractedData,
    passNumber,
    strategyUsed,
    dependenciesMet: true,
    analysisReason: lastError,
    actionId: action._id
  };
}


  private displayExecutionPlan(actions: ModelDefinition[], dependencyGraph: any): void {
    console.log(chalk.bold.cyan("\n📋 Execution Plan:"));
    
    let groupIndex = 0;
    for (const group of dependencyGraph.executionGroups) {
      groupIndex++;
      console.log(chalk.cyan(`\nGroup ${groupIndex} (Can run in parallel):`));
      
      for (const actionId of group) {
        const action = actions.find(a => a._id === actionId);
        const metadata = dependencyGraph.nodes.find((n: any) => n.id === actionId);
        if (action && metadata) {
          const deps = metadata.dependsOn.length > 0 ? 
            chalk.gray(` [depends on: ${metadata.dependsOn.length} actions]`) : '';
          const optional = metadata.isOptional ? chalk.yellow(' (optional)') : '';
          console.log(`  • ${action.title} (${action.modelName})${deps}${optional}`);
        }
      }
    }
  }

  private displayKnowledgeDiff(oldKnowledge: string, newKnowledge: string): void {
    const changes = diff.diffLines(oldKnowledge, newKnowledge);
    let hasChanges = false;
    
    console.log(chalk.yellow("   📝 Knowledge refinement:"));
    changes.forEach(part => {
      if (part.added) {
        hasChanges = true;
        console.log(chalk.green(`   + ${part.value.trim()}`));
      } else if (part.removed) {
        hasChanges = true;
        console.log(chalk.red(`   - ${part.value.trim()}`));
      }
    });
    
    if (!hasChanges) {
      console.log(chalk.gray("   No changes proposed"));
    }
  }

  private displayEnhancedSummary(
    connection: ConnectionDefinition, 
    results: EnhancedActionResult[],
    dependencyGraph: any
  ): void {
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success && !r.error?.includes("Skipped") && !r.isPermissionError && !r.isSkipped);
    const permissionErrors = results.filter(r => r.isPermissionError);
    const skipped = results.filter(r => r.error?.includes("Skipped") || r.isSkipped);
    const tokenSkipped = this.skippedActions.filter(s => s.category === 'token-destructive');
    
    const pass1Success = successes.filter(r => r.passNumber === 1);
    const pass2Success = successes.filter(r => r.passNumber === 2);
    
    console.log(chalk.bold.inverse(`\n\n📊 Enhanced Test Summary for: ${connection.name} 📊`));
    
    console.log(chalk.bold("\n🎯 Overall Results:"));
    const totalAttempted = results.length - skipped.length;
    const successRate = totalAttempted > 0 ? Math.round(successes.length / totalAttempted * 100) : 0;
    
    console.log(`  Success Rate: ${successRate === 100 ? chalk.green.bold(`${successRate}%`) : 
                                   successRate >= 80 ? chalk.yellow.bold(`${successRate}%`) : 
                                   chalk.red.bold(`${successRate}%`)} (${successes.length}/${totalAttempted})`);
    
    if (skipped.length > 0) {
      console.log(`  Skipped Actions: ${chalk.cyan(`${skipped.length}`)} (${tokenSkipped.length} token-related)`);
    }
    
    console.log(chalk.bold("\n📈 Pass-by-Pass Breakdown:"));
    console.log(`  Pass 1: ${chalk.green(`${pass1Success.length} successes`)} on first attempt`);
    console.log(`  Pass 2: ${chalk.yellow(`${pass2Success.length} successes`)} with enhanced context`);
    
    if (failures.length > 0) {
      console.log(chalk.bold.red(`\n❌ Failed Actions (${failures.length}):`));
      failures.forEach(result => {
        const metadata = dependencyGraph.nodes.find((n: any) => 
          n.actionName === result.actionTitle && n.modelName === result.modelName
        );
        console.log(`  • ${result.actionTitle} (${result.modelName})`);
        
        const errorReason = result.analysisReason || result.error || "Unknown error";
        console.log(chalk.red(`    Error: ${errorReason}`));
        
        console.log(chalk.gray(`    Attempts: ${result.attempts}, Pass: ${result.passNumber}`));
        if (!result.dependenciesMet) {
          console.log(chalk.yellow(`    Dependencies were not met`));
        }
        
        if (result.extractedData && Object.keys(result.extractedData.ids || {}).length > 0) {
          console.log(chalk.gray(`    Extracted IDs: ${JSON.stringify(result.extractedData.ids)}`));
        }
      });
    }

    if (permissionErrors.length > 0) {
      console.log(chalk.bold.red(`\n⛔ Permission/Authentication Errors (${permissionErrors.length}):`));
      console.log(chalk.gray("These require developer intervention to fix scopes/permissions\n"));
      permissionErrors.forEach(result => {
        console.log(`  • ${result.actionTitle} (${result.modelName})`);
        console.log(chalk.red(`    ${result.analysisReason || result.error}`));
      });
    }

    if (this.skippedActions.length > 0) {
      console.log(chalk.bold.yellow(`\n🚫 Skipped Actions (${this.skippedActions.length}):`));
      console.log(chalk.gray("These actions were automatically skipped to prevent token-related issues\n"));
      
      const skippedByCategory = this.skippedActions.reduce((acc, action) => {
        acc[action.category] = acc[action.category] || [];
        acc[action.category].push(action);
        return acc;
      }, {} as Record<string, SkippedActionInfo[]>);
      
      Object.entries(skippedByCategory).forEach(([category, actions]) => {
        console.log(chalk.yellow(`  ${category.toUpperCase()} (${actions.length} actions):`));
        actions.forEach(action => {
          console.log(`    • ${action.actionTitle} (${action.modelName})`);
          console.log(chalk.gray(`      Reason: ${action.reason}`));
          if (action.matchedKeywords.length > 0) {
            console.log(chalk.gray(`      Keywords: ${action.matchedKeywords.join(', ')}`));
          }
        });
        console.log();
      });
    }
    
    console.log(chalk.bold("\n💡 Insights & Recommendations:"));
    
    const strategies = results.filter(r => r.strategyUsed).map(r => r.strategyUsed!);
    const strategySuccess = new Map<string, number>();
    strategies.forEach(s => {
      const count = results.filter(r => r.strategyUsed === s && r.success).length;
      strategySuccess.set(s, count);
    });
    
    console.log("  • Most effective prompt strategies:");
    Array.from(strategySuccess.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([strategy, count]) => {
        console.log(`    - ${strategy}: ${count} successes`);
      });
    
    const dependencyFailures = failures.filter(f => !f.dependenciesMet);
    if (dependencyFailures.length > 0) {
      console.log(chalk.yellow(`  • ${dependencyFailures.length} actions failed due to unmet dependencies`));
    }
    
    const refinedActions = results.filter(r => r.finalKnowledge !== r.originalKnowledge);
    if (refinedActions.length > 0) {
      const refinedSuccess = refinedActions.filter(r => r.success).length;
      console.log(`  • Knowledge refined for ${refinedActions.length} actions (${refinedSuccess} succeeded after refinement)`);
    }
    
    const status = failures.length === 0 && permissionErrors.length === 0 && totalAttempted > 0 ? 
      chalk.green.inverse("\n✨ All actions completed successfully! ✨") :
      permissionErrors.length > 0 && failures.length === 0 ?
      chalk.yellow.inverse(`\n⚠️ ${permissionErrors.length} actions blocked by permissions`) :
      totalAttempted === 0 ? 
      chalk.blue("\n🤷 No actions were attempted.") :
      chalk.yellow.inverse(`\n⚠️ ${failures.length} actions failed, ${permissionErrors.length} blocked by permissions`);
    
    console.log(status);
  }
}
