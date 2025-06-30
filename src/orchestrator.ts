import { PicaApiService } from './connectors/pica_api_service';
import { EnhancedAgentService } from './agent_service';
import { KnowledgeRefiner } from './knowledge_refiner';
import { ContextManager } from './context_manager';
import { EnhancedDependencyAnalyzer } from './dependency_analyzer';
import { EnhancedPromptGenerator } from './prompt_generator';
import { ConnectionDefinition, ModelDefinition, ActionResult, ExecutionContext } from './interface';
import { PathParameterResolver } from './path_resolver';
import { ExecutionLogger } from './execution_logger';
import readline from 'readline/promises';
import chalk from 'chalk';
import * as diff from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import { tokenTracker } from './global_token_tracker';
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
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
  private contextManager: ContextManager;
  private dependencyAnalyzer: EnhancedDependencyAnalyzer;
  private promptGenerator: EnhancedPromptGenerator;
  private maxRetriesPerAction: number = 3;
  private useClaudeModels: boolean = true;
  private logger: ExecutionLogger | undefined;
  private permissionFailedActions: Set<string> = new Set();

  constructor(picaSdkSecretKey: string, openAIApiKey: string) {
    this.picaApiService = new PicaApiService(picaSdkSecretKey);
    this.agentService = new EnhancedAgentService(picaSdkSecretKey, openAIApiKey);
    this.knowledgeRefiner = new KnowledgeRefiner(openAIApiKey);
    this.contextManager = new ContextManager();
    this.dependencyAnalyzer = new EnhancedDependencyAnalyzer(this.useClaudeModels);
    this.promptGenerator = new EnhancedPromptGenerator(this.useClaudeModels);
  }

  public async start(): Promise<void> {
    tokenTracker.reset();
    
    try {
      const connections = await this.picaApiService.getAllConnectionDefinitions();
      if (!connections || connections.length === 0) {
        console.log("No connection definitions found. Exiting.");
        return;
      }

      this.displayConnections(connections);
      const selectedConnection = await this.promptForConnectionSelection(connections);
      if (!selectedConnection) return;

      console.log(chalk.bold(`\n📊 Selected platform: ${selectedConnection.name}`));
      await this.testPlatform(selectedConnection);

    } catch (error) {
      console.error("\n💥 An unexpected error occurred in the orchestrator:", error);
    } finally {
      tokenTracker.printSummary();
      
      if (this.logger) {
        this.logger.generateSummaryReport();
      }
      rl.close();
      console.log("\n👋 Enhanced test suite finished.");
    }
  }

 private displayConnections(connections: ConnectionDefinition[]): void {
  console.log(chalk.bold("\n🔗 Available Platforms for Testing:"));
  connections.forEach((conn, index) => {
    console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${chalk.bold(conn.name)} - ${conn.platform}`);
  });
}

  private async promptForConnectionSelection(connections: ConnectionDefinition[]): Promise<ConnectionDefinition | null> {
    while (true) {
      const choice = await rl.question('\n➡️ Select a platform by number (or type "exit"): ');
      if (choice.toLowerCase() === 'exit') return null;
      const selectedIndex = parseInt(choice) - 1;

      if (selectedIndex >= 0 && selectedIndex < connections.length) {
        return connections[selectedIndex];
      }
      console.log(chalk.red("Invalid selection. Please try again."));
    }
  }

  private async testPlatform(connection: ConnectionDefinition): Promise<void> {
  let modelDefinitions = await this.picaApiService.getModelDefinitions(connection._id);

  modelDefinitions = modelDefinitions.filter(action => action.supported !== false);
  console.log(chalk.bold(`\n📋 Found ${modelDefinitions.length} supported actions for ${connection.name}`));

  console.log(chalk.bold(`\n📋 Found ${modelDefinitions.length} actions for ${connection.name}`));
  if (!this.logger) {
    this.logger = new ExecutionLogger(connection.name);
    this.agentService.setLogger(this.logger);
  }

  this.contextManager.reset();

  console.log(chalk.cyan("\n🧩 Analyzing action dependencies..."));
  const dependencyGraph = await this.dependencyAnalyzer.analyzeDependencies(
    modelDefinitions,
    connection.name
  );

  const sortedActions = this.dependencyAnalyzer.getSortedActions(dependencyGraph, modelDefinitions);
  this.displayExecutionPlan(sortedActions, dependencyGraph);

  const results: EnhancedActionResult[] = [];
  const failedActions: Array<{action: ModelDefinition, result: EnhancedActionResult, reason: string}> = [];

  console.log(chalk.bold.inverse("\n\n🔄 PASS 1: Initial Execution with Dependency Order 🔄"));

  for (const action of sortedActions) {
    const actionMetadata = this.dependencyAnalyzer.getActionMetadata(action._id, dependencyGraph);

    if (!action.knowledge || action.knowledge.trim() === "") {
      console.log(chalk.gray(`\n⏭️ Skipping "${action.title}" - No knowledge provided.`));
      results.push({
        actionTitle: action.title,
        modelName: action.modelName,
        success: false,
        error: "Skipped - No knowledge",
        originalKnowledge: "",
        attempts: 0,
        passNumber: 1,
        dependenciesMet: true
      });
      continue;
    }

    console.log(chalk.bold.blue(`\n🎯 Testing: "${action.title}" (${action.modelName})`));
    if (results.length > 0 && results.length % 5 === 0) {
      try {
        this.logger.generateSummaryReport();
      } catch (err) {
        console.error('Error generating intermediate summary:', err);
      }
    }
    if (actionMetadata) {
      console.log(chalk.gray(`   Priority: ${actionMetadata.priority}, Optional: ${actionMetadata.isOptional}`));
    }
    const result = await this.executeActionWithSmartRetries(action, 1, dependencyGraph, this.maxRetriesPerAction);
    results.push(result);

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
}


  public handleInterrupt(): void {
    console.log(chalk.blue("\ Shutting down and generating final report..."));
    if (this.logger) {
      this.logger.generateSummaryReport();
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
  
  const successfulModified = results.filter(r => {
  return r.success && 
         r.finalKnowledge && 
         r.finalKnowledge !== r.originalKnowledge 
});
  
  if (successfulModified.length === 0) {
    console.log(chalk.gray('\nNo modified knowledge to save.'));
    return;
  }
  
  const knowledgeDir = path.join(process.cwd(), 'knowledge', platformName);
  if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
  }
  
  console.log(chalk.blue(`\n💾 Saving ${successfulModified.length} refined knowledge files...`));
  
  successfulModified.forEach(result => {
    const actionTitle = result.actionTitle.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
    const actionId = (result.actionId || 'unknown').replace(/[<>:"/\\|?*:]/g, '_');
    const filename = `${actionTitle}_${actionId.substring(0, 20)}.md`;
    const filepath = path.join(knowledgeDir, filename);
    
    const content = `# ${result.actionTitle}\n\n## Model: ${result.modelName}\n\n## Knowledge\n\n${result.finalKnowledge}`;
    
    fs.writeFileSync(filepath, content);
    console.log(chalk.green(`   ✓ Saved: ${filename}`));
  });
}

private saveKnowledgeImmediately(action: ModelDefinition, refinedKnowledge: string): void {
  try {
    const platformName = action.connectionPlatform;
    const knowledgeDir = path.join(process.cwd(), 'knowledge', platformName);
    if (!fs.existsSync(knowledgeDir)) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
    }
    
    const actionTitle = action.title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
    const actionId = action._id.replace(/[<>:"/\\|?*]/g, '_');
    const filename = `${actionTitle}_${actionId.substring(0, 20)}.md`;
    const filepath = path.join(knowledgeDir, filename);
    const content = `# ${action.title}\n\n## Model: ${action.modelName}\n\n## Knowledge\n\n${refinedKnowledge}`;
    
    fs.writeFileSync(filepath, content);
    console.log(chalk.gray(`   💾 Knowledge saved: ${filename}`));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.log(chalk.yellow(`   ⚠️ Failed to save knowledge: ${errorMessage}`));
  }
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
    const { prompt, strategy } = await this.promptGenerator.generateAdaptivePrompt(
          { ...action, knowledge: currentKnowledge },
          context,
          [],
          attempts,
          previousError || lastError,
          dependencyGraph,
          lastAgentResponse 
        );
    
    strategyUsed = strategy.tone;
    
    const agentResult = await this.agentService.executeSmartTask(prompt, undefined, action, context, attempts);

   
    if (!agentResult.success && (agentResult.output?.includes('403') || agentResult.error?.includes('403'))) {
        console.log(chalk.yellow("   Directly detected a 403 error. Flagging as a definitive permission error."));
        agentResult.isPermissionError = true;
    }
    
    if (agentResult.success) {
      console.log(chalk.green(`   ✅ SUCCESS: ${agentResult.analysisReason || "Completed"}`));
      if (currentKnowledge !== action.knowledge) {
      this.saveKnowledgeImmediately(action, currentKnowledge);
      }
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
        this.saveKnowledgeImmediately(action, currentKnowledge);
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
    const failures = results.filter(r => !r.success && !r.error?.includes("Skipped") && !r.isPermissionError);
    const permissionErrors = results.filter(r => r.isPermissionError);
    const skipped = results.filter(r => r.error?.includes("Skipped"));
    
    const pass1Success = successes.filter(r => r.passNumber === 1);
    const pass2Success = successes.filter(r => r.passNumber === 2);
    
    console.log(chalk.bold.inverse(`\n\n📊 Enhanced Test Summary for: ${connection.name} 📊`));
    
    console.log(chalk.bold("\n🎯 Overall Results:"));
    const totalAttempted = results.length - skipped.length;
    const successRate = totalAttempted > 0 ? Math.round(successes.length / totalAttempted * 100) : 0;
    
    console.log(`  Success Rate: ${successRate === 100 ? chalk.green.bold(`${successRate}%`) : 
                                   successRate >= 80 ? chalk.yellow.bold(`${successRate}%`) : 
                                   chalk.red.bold(`${successRate}%`)} (${successes.length}/${totalAttempted})`);
    
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
