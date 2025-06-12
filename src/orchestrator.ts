// src/enhanced_orchestrator.ts
import { PicaApiService } from './pica_api_service';
import { EnhancedAgentService } from './agent_service';
import { KnowledgeRefiner } from './knowledge_refiner';
import { ContextManager } from './context_manager';
import { EnhancedDependencyAnalyzer } from './dependency_analyzer';
import { EnhancedPromptGenerator } from './prompt_generator';
import { ConnectionDefinition, ModelDefinition, ActionResult } from './interface';
import readline from 'readline/promises';
import chalk from 'chalk';
import * as diff from 'diff';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

interface EnhancedActionResult extends ActionResult {
  passNumber: number;
  strategyUsed?: string;
  dependenciesMet: boolean;
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

  constructor(picaSdkSecretKey: string, openAIApiKey: string) {
    this.picaApiService = new PicaApiService(picaSdkSecretKey);
    this.agentService = new EnhancedAgentService(picaSdkSecretKey, openAIApiKey);
    this.knowledgeRefiner = new KnowledgeRefiner(openAIApiKey);
    this.contextManager = new ContextManager();
    this.dependencyAnalyzer = new EnhancedDependencyAnalyzer(this.useClaudeModels);
    this.promptGenerator = new EnhancedPromptGenerator(this.useClaudeModels);
  }

  public async start(): Promise<void> {
    console.log(chalk.bold.cyan("🚀 Enhanced PicaOS Testing Suite v2.0 with 3-Pass Strategy 🚀"));
    console.log(chalk.gray("Using Claude models for enhanced analysis\n"));

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
      console.error("\n💥 An unexpected error occurred:", error);
    } finally {
      rl.close();
      console.log("\n👋 Enhanced test suite finished.");
    }
  }

  private displayConnections(connections: ConnectionDefinition[]): void {
    console.log(chalk.bold("\n🔗 Available Platforms for Testing:"));
    connections.forEach((conn, index) => {
      const status = conn.status === 'Beta' ? chalk.yellow(' (Beta)') : '';
      console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${chalk.bold(conn.name)} - ${conn.platform}${status}`);
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
    const modelDefinitions = await this.picaApiService.getModelDefinitions(connection._id);
    if (!modelDefinitions || modelDefinitions.length === 0) {
      console.log(chalk.yellow(`No model definitions found for ${connection.name}.`));
      return;
    }

    console.log(chalk.bold(`\n📋 Found ${modelDefinitions.length} actions for ${connection.name}`));
    
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

      const dependenciesMet = this.checkDependencies(action._id, dependencyGraph, results);
      
      if (!dependenciesMet && !actionMetadata?.isOptional) {
        console.log(chalk.yellow(`\n⚠️ Skipping "${action.title}" - Dependencies not met`));
        failedActions.push({
          action,
          result: {
            actionTitle: action.title,
            modelName: action.modelName,
            success: false,
            error: "Dependencies not met",
            originalKnowledge: action.knowledge,
            attempts: 0,
            passNumber: 1,
            dependenciesMet: false
          },
          reason: "dependencies"
        });
        continue;
      }

      console.log(chalk.bold.blue(`\n🎯 Testing: "${action.title}" (${action.modelName})`));
      if (actionMetadata) {
        console.log(chalk.gray(`   Priority: ${actionMetadata.priority}, Optional: ${actionMetadata.isOptional}`));
      }

      const result = await this.executeActionWithSmartRetries(action, 1, dependencyGraph);
      results.push(result);

      this.contextManager.updateContext(action, result, result.extractedData);

      if (!result.success) {
        failedActions.push({ action, result, reason: "execution_failed" });
      }
    }

    if (failedActions.length > 0) {
      console.log(chalk.bold.inverse(`\n\n🔄 PASS 2: Retrying ${failedActions.length} Failed Actions with Enhanced Context 🔄`));
      
      const pass2Failures: typeof failedActions = [];
      
      for (const { action, result: pass1Result, reason } of failedActions) {
        console.log(chalk.bold.yellow(`\n🔁 Retrying: "${action.title}"`));
        console.log(chalk.gray(`   Previous failure: ${pass1Result.error}`));
        
        const knowledgeToUse = pass1Result.finalKnowledge || action.knowledge;
        const enhancedAction = { ...action, knowledge: knowledgeToUse };
        
        const pass2Result = await this.executeActionWithSmartRetries(
          enhancedAction, 
          2, 
          dependencyGraph,
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
        
        if (!pass2Result.success) {
          pass2Failures.push({ action: enhancedAction, result: pass2Result, reason: "pass2_failed" });
        } else {
          this.contextManager.updateContext(enhancedAction, pass2Result, pass2Result.extractedData);
        }
      }
      
      if (pass2Failures.length > 0) {
        console.log(chalk.bold.inverse(`\n\n🔄 PASS 3: Final Attempt for ${pass2Failures.length} Stubborn Failures 🔄`));
        
        const metaStrategy = await this.promptGenerator.generateMetaPrompt(
          pass2Failures,
          this.contextManager.getContext()
        );
        
        console.log(chalk.magenta("\n🧠 Meta-strategy generated for remaining failures"));
        
        for (const { action, result: pass2Result } of pass2Failures) {
          console.log(chalk.bold.red(`\n🎲 Final attempt: "${action.title}"`));
          
          const pass3Result = await this.executeActionWithMetaStrategy(
            action,
            3,
            dependencyGraph,
            metaStrategy,
            pass2Result.error
          );
          
          const originalIndex = results.findIndex(r => 
            r.actionTitle === action.title && r.modelName === action.modelName
          );
          if (originalIndex >= 0) {
            results[originalIndex] = {
              ...pass3Result,
              attempts: results[originalIndex].attempts + pass3Result.attempts,
              originalKnowledge: results[originalIndex].originalKnowledge,
              passNumber: 3
            };
          }
          
          if (pass3Result.success) {
            this.contextManager.updateContext(action, pass3Result, pass3Result.extractedData);
          }
        }
      }
    }

    this.displayEnhancedSummary(connection, results, dependencyGraph);
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

  private async executeActionWithSmartRetries(
    action: ModelDefinition,
    passNumber: number,
    dependencyGraph: any,
    previousError?: string
  ): Promise<EnhancedActionResult> {
    let currentKnowledge = action.knowledge;
    let attempts = 0;
    let lastError: string | undefined;
    let extractedData: any;
    let strategyUsed: string | undefined;

    while (attempts < this.maxRetriesPerAction) {
      attempts++;
      console.log(chalk.blue(`   Attempt ${attempts}/${this.maxRetriesPerAction}...`));

      const context = this.contextManager.getContext();
      const { prompt, strategy } = await this.promptGenerator.generateAdaptivePrompt(
        { ...action, knowledge: currentKnowledge },
        context,
        [],
        attempts,
        previousError || lastError,
        dependencyGraph
      );
      
      strategyUsed = strategy.tone;
      
      const promptPreview = prompt.split('---')[0].trim();
      console.log(chalk.gray(`   Strategy: ${strategy.tone}, Context: ${strategy.contextLevel}`));
      console.log(chalk.gray(`   Prompt: ${promptPreview.substring(0, 150)}...`));
      
      const agentResult = await this.agentService.executeTask(prompt);
      
      if (agentResult.success) {
        console.log(chalk.green(`   ✅ SUCCESS: ${agentResult.analysisReason || "Completed"}`));
        this.promptGenerator.recordPromptResult(action._id, prompt, true);
        
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
          dependenciesMet: true
        };
      }

      lastError = agentResult.error || "Unknown error";
      console.log(chalk.red(`   ❌ FAILED: ${agentResult.analysisReason || lastError}`));
      this.promptGenerator.recordPromptResult(action._id, prompt, false);

      if (attempts < this.maxRetriesPerAction) {
        console.log(chalk.yellow("   💡 Refining approach..."));
        
        const refinement = await this.knowledgeRefiner.refineKnowledge(
          currentKnowledge,
          lastError,
          action,
          context,
          prompt
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
      dependenciesMet: true
    };
  }

  private async executeActionWithMetaStrategy(
    action: ModelDefinition,
    passNumber: number,
    dependencyGraph: any,
    metaStrategy: string,
    previousError?: string
  ): Promise<EnhancedActionResult> {
    console.log(chalk.magenta("   Using meta-strategy approach..."));
    
    const context = this.contextManager.getContext();
    
    const basePrompt = await this.agentService.generateTaskPrompt(
      action,
      context,
      []
    );
    
    const enhancedPrompt = `${metaStrategy}\n\n---\n\nWith the above strategy in mind:\n${basePrompt}`;
    
    const agentResult = await this.agentService.executeTask(enhancedPrompt);
    
    if (agentResult.success) {
      console.log(chalk.green.bold(`   ✅ META-STRATEGY SUCCESS: ${agentResult.analysisReason}`));
    } else {
      console.log(chalk.red.bold(`   ❌ META-STRATEGY FAILED: ${agentResult.error}`));
    }
    
    return {
      success: agentResult.success,
      output: agentResult.output,
      error: agentResult.error,
      originalKnowledge: action.knowledge,
      finalKnowledge: action.knowledge,
      attempts: 1,
      actionTitle: action.title,
      modelName: action.modelName,
      extractedData: agentResult.extractedData,
      passNumber,
      strategyUsed: "meta-strategy",
      dependenciesMet: true
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
    const failures = results.filter(r => !r.success && !r.error?.includes("Skipped"));
    const skipped = results.filter(r => r.error?.includes("Skipped"));
    
    const pass1Success = successes.filter(r => r.passNumber === 1);
    const pass2Success = successes.filter(r => r.passNumber === 2);
    const pass3Success = successes.filter(r => r.passNumber === 3);
    
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
    console.log(`  Pass 3: ${chalk.cyan(`${pass3Success.length} successes`)} with meta-strategy`);
    
    if (failures.length > 0) {
      console.log(chalk.bold.red(`\n❌ Failed Actions (${failures.length}):`));
      failures.forEach(result => {
        const metadata = dependencyGraph.nodes.find((n: any) => 
          n.actionName === result.actionTitle && n.modelName === result.modelName
        );
        console.log(`  • ${result.actionTitle} (${result.modelName})`);
        console.log(chalk.red(`    Error: ${result.error}`));
        console.log(chalk.gray(`    Attempts: ${result.attempts}, Pass: ${result.passNumber}`));
        if (!result.dependenciesMet) {
          console.log(chalk.yellow(`    Dependencies were not met`));
        }
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
    
    const status = failures.length === 0 && totalAttempted > 0 ? 
      chalk.green.inverse("\n✨ All actions completed successfully! ✨") :
      totalAttempted === 0 ? chalk.blue("\n🤷 No actions were attempted.") :
      chalk.yellow.inverse(`\n⚠️ ${failures.length} actions still need attention.`);
    
    console.log(status);
  }
}