import { PicaApiService } from './pica_api_service';
import { EnhancedAgentService } from './agent_service';
import { KnowledgeRefiner } from './knowledge_refiner';
import { ContextManager } from './context_manager';
import { ConnectionDefinition, ModelDefinition, ActionResult } from './interface';
import readline from 'readline/promises';
import chalk from 'chalk'; 
import * as diff from 'diff'; 

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

export class PicaosTestingOrchestrator {
  private picaApiService: PicaApiService;
  private agentService: EnhancedAgentService;
  private knowledgeRefiner: KnowledgeRefiner;
  private contextManager: ContextManager;
  private maxRetriesPerAction: number = 3;

  constructor(picaSdkSecretKey: string, openAIApiKey: string) {
    this.picaApiService = new PicaApiService(picaSdkSecretKey);
    this.agentService = new EnhancedAgentService(picaSdkSecretKey, openAIApiKey);
    this.knowledgeRefiner = new KnowledgeRefiner(openAIApiKey);
    this.contextManager = new ContextManager();
  }

  public async start(): Promise<void> {
    console.log("🚀 Starting Enhanced PicaOS Testing Suite with Mastra AI 🚀");

    try {
      const connections = await this.picaApiService.getAllConnectionDefinitions();
      if (!connections || connections.length === 0) {
        console.log("No connection definitions found. Exiting.");
        return;
      }

      this.displayConnections(connections);
      const selectedConnection = await this.promptForConnectionSelection(connections);
      if (!selectedConnection) return;

      console.log(`\nSelected platform: ${selectedConnection.name}. Fetching actions...`);
      await this.testPlatform(selectedConnection);

    } catch (error) {
      console.error("\n💥 An unexpected error occurred:", error);
    } finally {
      rl.close();
      console.log("\n👋 Enhanced test suite finished.");
    }
  }

  private displayConnections(connections: ConnectionDefinition[]): void {
    console.log("\n🔗 Available Platforms for Testing:");
    connections.forEach((conn, index) => {
      console.log(`${index + 1}. ${conn.name} (Platform: ${conn.platform}, ID: ${conn._id})`);
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
      console.log("Invalid selection. Please try again.");
    }
  }

  private getActionPriority(actionName: string): number {
    const name = actionName.toLowerCase();
    if (name.includes('create') || name.includes('post')) return 1;
    if (name.includes('list') || name.includes('getmany')) return 2;
    if (name.includes('get') || name.includes('getone')) return 3;
    if (name.includes('update') || name.includes('patch')) return 4;
    if (name.includes('delete') || name.includes('remove')) return 5;
    return 6;
  }

  private async testPlatform(connection: ConnectionDefinition): Promise<void> {
    const modelDefinitions = await this.picaApiService.getModelDefinitions(connection._id);
    if (!modelDefinitions || modelDefinitions.length === 0) {
      console.log(`No model definitions found for ${connection.name}.`);
      return;
    }

    console.log(`\nFound ${modelDefinitions.length} actions for ${connection.name}.`);
    
    this.contextManager.reset();

    const sortedActions = [...modelDefinitions].sort((a, b) => 
      this.getActionPriority(a.actionName) - this.getActionPriority(b.actionName)
    );

    const results: ActionResult[] = [];
    const failedActionsLog: Array<{action: ModelDefinition, result: ActionResult}> = [];


    console.log("\n=== FIRST PASS: Testing all actions in priority order ===");
    for (const action of sortedActions) {
      if (!action.knowledge || action.knowledge.trim() === "") {
        console.log(`\n🟡 Skipping "${action.title}" - No knowledge provided.`);
        results.push({
          actionTitle: action.title,
          modelName: action.modelName,
          success: false,
          error: "Skipped - No knowledge",
          originalKnowledge: "",
          attempts: 0
        });
        continue;
      }

      console.log(`\n--- Testing Action: "${action.title}" (${action.modelName}) ---`);
      const result = await this.testActionWithRetries(action);
      results.push(result);

      this.contextManager.updateContext(action, result, result.extractedData);

      if (!result.success) {
        failedActionsLog.push({action, result});
      }
    }

    if (failedActionsLog.length > 0) {
      console.log(`\n=== SECOND PASS: Retrying ${failedActionsLog.length} failed actions with context ===`);
      
      for (const {action: failedAction, result: firstPassResult} of failedActionsLog) {
        console.log(`\n--- Retrying Action: "${failedAction.title}" (${failedAction.modelName}) ---`);
        const knowledgeForRetry = firstPassResult.finalKnowledge || failedAction.knowledge;
        const contextualResult = await this.testActionWithContextualRetries(
            { ...failedAction, knowledge: knowledgeForRetry }, 
            firstPassResult
        );
        
        const originalResultIndex = results.findIndex(r => 
          r.actionTitle === failedAction.title && r.modelName === failedAction.modelName
        );
        if (originalResultIndex >= 0) {
          results[originalResultIndex] = { 
            ...contextualResult, 
            attempts: firstPassResult.attempts + contextualResult.attempts, 
            originalKnowledge: failedAction.knowledge, 
            finalKnowledge: contextualResult.finalKnowledge, 
            contextUsed: true 
          };
        }
      }
    }

    this.summarizeResults(connection, results);
  }

  private displayKnowledgeDiff(oldKnowledge: string, newKnowledge: string): void {
    const changes = diff.diffLines(oldKnowledge, newKnowledge);
    let hasChanges = false;
    const diffText = changes
      .map(part => {
        if (part.added) {
          hasChanges = true;
          return chalk.green(part.value.split('\n').map(l => `+ ${l}`).join('\n'));
        }
        if (part.removed) {
          hasChanges = true;
          return chalk.red(part.value.split('\n').map(l => `- ${l}`).join('\n'));
        }
        return ''; 
      })
      .filter(Boolean)
      .join('');

    if (hasChanges) {
      console.log(chalk.yellow("\n\t🧠 Knowledge refined. Changes:"));
      console.log(diffText);
    } else {
      console.log(chalk.gray("\t🤔 Knowledge refiner proposed no effective changes."));
    }
  }
  private async testActionWithRetries(action: ModelDefinition): Promise<ActionResult> {
    let currentKnowledge = action.knowledge;
    let attempts = 0;
    let lastError: string | undefined;
    let lastOutput: any;
    let extractedData: any;
    let analysisReason: string | undefined;

    while (attempts < this.maxRetriesPerAction) {
      attempts++;
      console.log(chalk.blue(`\tAttempt ${attempts}/${this.maxRetriesPerAction}...`));

      const context = this.contextManager.getContext();
      const actionToExecute = { ...action, knowledge: currentKnowledge };
      
      const taskPrompt = await this.agentService.generateTaskPrompt(actionToExecute, context);
      
      const promptForDisplay = taskPrompt.split('Knowledge:')[0] + 'Knowledge: [Omitted for brevity]';
      console.log(chalk.gray(`\t📋 Prompt Sent:\n\t${promptForDisplay.replace(/\n/g, "\n\t")}`));
      
      const agentResult = await this.agentService.executeTask(taskPrompt);
      analysisReason = agentResult.analysisReason;
      
      if (agentResult.success) {
        console.log(chalk.green.bold(`\t✅ SUCCESS:`), chalk.green(analysisReason || "Action completed successfully."));
        return {
          success: true,
          output: agentResult.output,
          originalKnowledge: action.knowledge,
          finalKnowledge: currentKnowledge,   
          attempts,
          actionTitle: action.title,
          modelName: action.modelName,
          extractedData: agentResult.extractedData
        };
      }

      lastError = agentResult.error || "Unknown error during agent execution";
      console.log(chalk.red.bold(`\t❌ FAILED:`), chalk.red(analysisReason || "Action failed."));
      if(agentResult.error) {
        console.log(chalk.red(`\t   Error Details: ${agentResult.error}`));
      }


      if (attempts < this.maxRetriesPerAction) {
        console.log(chalk.yellow("\t💡 Refining knowledge..."));
        const refinedKnowledge = await this.knowledgeRefiner.refineKnowledge(
          currentKnowledge, 
          lastError,
          action, 
          context
        );

        if (refinedKnowledge && refinedKnowledge.trim().toUpperCase() !== "NO_CHANGE") {
          this.displayKnowledgeDiff(currentKnowledge, refinedKnowledge);
          currentKnowledge = refinedKnowledge.trim();
        } else {
          console.log(chalk.gray("\t🤷 Knowledge refiner did not suggest an update. Retrying with same knowledge."));
        }
      }
    }

    console.log(chalk.red.bold(`\t🔥 FINAL FAILURE for "${action.title}" after ${attempts} attempts.`));
    return {
      success: false,
      error: lastError,
      output: lastOutput,
      originalKnowledge: action.knowledge,
      finalKnowledge: currentKnowledge, 
      attempts,
      actionTitle: action.title,
      modelName: action.modelName,
      extractedData
    };
  }

  private async testActionWithContextualRetries(
    action: ModelDefinition, 
    firstPassResult: ActionResult 
  ): Promise<ActionResult> {
    console.log(chalk.cyan.bold(`\t🔄 Retrying with full context...`));
    
    const contextualContext = this.contextManager.getContextForFailedActions();
    
    const taskPrompt = await this.agentService.generateTaskPrompt(action, contextualContext);
    
    const promptForDisplay = taskPrompt.split('Knowledge:')[0] + 'Knowledge: [Omitted for brevity]';
    console.log(chalk.gray(`\t📋 Prompt Sent:\n\t${promptForDisplay.replace(/\n/g, "\n\t")}`));

    const agentResult = await this.agentService.executeTask(taskPrompt);
    const analysisReason = agentResult.analysisReason;

    if (agentResult.success) {
      console.log(chalk.green.bold(`\t✅ CONTEXTUAL SUCCESS:`), chalk.green(analysisReason || `"${action.title}" succeeded with enhanced context.`));
      return {
        success: true,
        output: agentResult.output,
        originalKnowledge: firstPassResult.originalKnowledge, 
        finalKnowledge: action.knowledge,
        attempts: 1, 
        actionTitle: action.title,
        modelName: action.modelName,
        extractedData: agentResult.extractedData,
        contextUsed: true
      };
    }

    console.log(chalk.red.bold(`\t❌ CONTEXTUAL FAILURE:`), chalk.red(analysisReason || `"${action.title}" failed even with enhanced context.`));
    if (agentResult.error) {
        console.log(chalk.red(`\t   Error Details: ${agentResult.error}`));
    }
    
    return {
      success: false,
      error: agentResult.error || "Failed even with enhanced context",
      output: agentResult.output,
      originalKnowledge: firstPassResult.originalKnowledge,
      finalKnowledge: action.knowledge, 
      attempts: 1, 
      actionTitle: action.title,
      modelName: action.modelName,
      extractedData: agentResult.extractedData,
      contextUsed: true
    };
  }

  private summarizeResults(connection: ConnectionDefinition, results: ActionResult[]): void {
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success && !(r.error || "").includes("Skipped"));
    const skipped = results.filter(r => (r.error || "").includes("Skipped"));

    const successOnFirstTry = successes.filter(r => r.attempts === 1 && !r.contextUsed).length;
    const successWithRetry = successes.filter(r => r.attempts > 1 && !r.contextUsed).length;
    const successWithContext = successes.filter(r => r.contextUsed).length;
    
    const refinedAndSucceeded = results.filter(r => r.success && r.finalKnowledge !== r.originalKnowledge).length;
    const refinedAndFailed = results.filter(r => !r.success && r.finalKnowledge !== r.originalKnowledge).length;

    console.log(chalk.bold.inverse(`\n\n📊 PicaOS Test Summary for: ${connection.name} 📊`));
    
    console.log(chalk.bold("\n--- Overall Performance ---"));
    const totalAttempted = results.length - skipped.length;
    if (totalAttempted > 0) {
        const successRate = Math.round(successes.length / totalAttempted * 100);
        console.log(`  Overall Success Rate: ${chalk.bold(successRate === 100 ? chalk.green(`${successRate}%`) : chalk.yellow(`${successRate}%`))} (${successes.length}/${totalAttempted} actions)`);
        console.log(`    - ${chalk.green(`${successOnFirstTry} succeeded on first attempt.`)}`);
        console.log(`    - ${chalk.yellow(`${successWithRetry} succeeded after auto-refinement.`)}`);
        console.log(`    - ${chalk.cyan(`${successWithContext} succeeded on 2nd pass with context.`)}`);
    } else {
        console.log(chalk.blue("No actions were attempted."));
    }
    
    if (failures.length > 0) {
      console.log(chalk.red(`\n--- ❌ Failed Actions (${failures.length}) ---`));
      failures.forEach(result => {
        console.log(`  - ${chalk.bold(result.actionTitle)} (${result.modelName})`);
        console.log(`    ${chalk.red.italic(`Error: ${result.error}`)}`);
        if (result.finalKnowledge !== result.originalKnowledge) {
          console.log(chalk.yellow.dim(`    (Failed after knowledge refinement)`));
        }
      });
    }

    if (skipped.length > 0) {
      console.log(chalk.gray(`\n--- ⏭️ Skipped Actions (${skipped.length}) ---`));
      skipped.forEach(r => console.log(`  - ${r.actionTitle} (Reason: No knowledge)`));
    }

    console.log(chalk.bold("\n--- 💡 Key Insights & Recommendations ---"));
    if (refinedAndSucceeded > 0 || refinedAndFailed > 0) {
        const refinementSuccessRate = Math.round(refinedAndSucceeded / (refinedAndSucceeded + refinedAndFailed) * 100);
        console.log(`  - ${chalk.cyan('Knowledge Refinement:')} ${refinedAndSucceeded + refinedAndFailed} actions were refined. Success rate was ${chalk.bold(`${refinementSuccessRate}%`)}.`);
    }
    if (failures.length > 0) {
        console.log(`  - ${chalk.red('Review failures:')} Manually inspect the ${failures.length} failed actions. The error messages above are your starting point.`);
    }
    if (successWithRetry > 0 || successWithContext > 0) {
        console.log(`  - ${chalk.yellow('Update Base Knowledge:')} Actions that required retries or context to succeed are prime candidates for having their base knowledge updated in the platform.`);
    }
    if (skipped.length > 0) {
        console.log(`  - ${chalk.gray('Document Skipped Actions:')} Add knowledge for the ${skipped.length} skipped actions to include them in testing.`);
    }

    const overallStatus = failures.length === 0 && totalAttempted > 0 ? 
      chalk.green.inverse("\n✨ All attempted actions completed successfully! ✨") : 
      (totalAttempted === 0 ? chalk.blue("\n🤷 No actions were attempted.") : chalk.red.inverse("\n⚠️ Some actions failed. Review the insights above."));
    console.log(overallStatus);
  }
}