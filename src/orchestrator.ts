import { PicaApiService } from './pica_api_service';
import { EnhancedAgentService } from './agent_service';
import { KnowledgeRefiner } from './knowledge_refiner';
import { ContextManager } from './context_manager';
import { ConnectionDefinition, ModelDefinition, ActionResult } from './interface';
import readline from 'readline/promises';

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

  private async testActionWithRetries(action: ModelDefinition): Promise<ActionResult> {
    let currentKnowledge = action.knowledge;
    let attempts = 0;
    let lastError: string | undefined;
    let lastOutput: any;
    let extractedData: any;

    while (attempts < this.maxRetriesPerAction) {
      attempts++;
      console.log(`\tAttempt ${attempts}/${this.maxRetriesPerAction}...`);

      const context = this.contextManager.getContext();
      const actionToExecute = { ...action, knowledge: currentKnowledge };
      
      const taskPrompt = await this.agentService.generateTaskPrompt(actionToExecute, context);
      console.log(`\n\t📋 Sending Prompt to Agent (Attempt ${attempts}):\n\t"""\n\t${taskPrompt.replace(/\n/g, "\n\t")}\n\t"""`);
      
      const agentResult = await this.agentService.executeTask(taskPrompt);
      console.log(`\tAgent Raw Output:\n\t"""\n\t${(agentResult.output || "No text output from agent.").replace(/\n/g, "\n\t")}\n\t"""`);
      if (agentResult.error && !agentResult.success) {
        console.warn(`\tAgent Reported Error: ${agentResult.error}`);
      }
      lastOutput = agentResult.output; 
      extractedData = agentResult.extractedData; 

      if (agentResult.success) {
        console.log(`\t✅ SUCCESS: "${action.title}" on attempt ${attempts}`);
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
      console.warn(`\t❌ FAILED (Attempt ${attempts}): ${lastError}`);

      if (attempts < this.maxRetriesPerAction) {
        console.log("\t💡 Refining knowledge for next attempt...");
        const refinedKnowledge = await this.knowledgeRefiner.refineKnowledge(
          currentKnowledge, 
          lastError,
          action, 
          context
        );

        if (refinedKnowledge && refinedKnowledge.trim() !== "" && refinedKnowledge.trim().toUpperCase() !== "NO_CHANGE") {
          if (refinedKnowledge.trim() !== currentKnowledge.trim()) {
            console.log("\t✨ Knowledge has been refined. Differences:");
            console.log(`\t--- OLD KNOWLEDGE (snippet) ---\n${currentKnowledge.substring(0, 200)}...\n\t-----------------------------`);
            console.log(`\t--- NEW KNOWLEDGE (snippet) ---\n${refinedKnowledge.substring(0, 200)}...\n\t-----------------------------`);
            currentKnowledge = refinedKnowledge.trim();
            console.log("\t🔄 Retrying with updated knowledge...");
          } else {
            console.log("\t🤔 Knowledge refiner proposed no effective changes to the current knowledge. Retrying with same knowledge.");
          }
        } else {
          console.log("\t🤷 Knowledge refiner did not suggest an update or suggestion was invalid. Retrying with same knowledge.");
        }
      }
    }

    console.log(`\t❌ FINAL FAILURE for "${action.title}" after ${attempts} attempts.`);
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
    console.log(`\t🔄 Retrying "${action.title}" with full context (attempt ${firstPassResult.attempts + 1})...`);
    
    const contextualContext = this.contextManager.getContextForFailedActions();
    
    const taskPrompt = await this.agentService.generateTaskPrompt(action, contextualContext);
    console.log(`\n\t📋 Sending Prompt to Agent (Contextual Retry):\n\t"""\n\t${taskPrompt.replace(/\n/g, "\n\t")}\n\t"""`);

    const agentResult = await this.agentService.executeTask(taskPrompt);
    console.log(`\tAgent Raw Output (Contextual Retry):\n\t"""\n\t${(agentResult.output || "No text output from agent.").replace(/\n/g, "\n\t")}\n\t"""`);
    if (agentResult.error && !agentResult.success) {
      console.warn(`\tAgent Reported Error (Contextual Retry): ${agentResult.error}`);
    }
    if (agentResult.success) {
      console.log(`\t✅ CONTEXTUAL SUCCESS: "${action.title}"`);
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

    console.warn(`\t❌ CONTEXTUAL FAILURE for "${action.title}": ${agentResult.error || "Unknown error"}`);
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
    console.log(`\n\n📊 Enhanced Test Summary for Platform: ${connection.name} 📊`);
    
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success && !(r.error || "").includes("Skipped"));
    const skipped = results.filter(r => (r.error || "").includes("Skipped"));
    const contextualSuccesses = successes.filter(r => r.contextUsed);
    const totalAttempted = results.length - skipped.length;


    console.log("\n📈 Overall Statistics:");
    console.log(`Total Actions Defined: ${results.length}`);
    console.log(`Skipped (No Knowledge): ${skipped.length}`);
    console.log(`Total Attempted: ${totalAttempted}`);
    if (totalAttempted > 0) {
        console.log(`Successfully Completed: ${successes.length} (${Math.round(successes.length / totalAttempted * 100)}%)`);
        console.log(`Failed: ${failures.length} (${Math.round(failures.length / totalAttempted * 100)}%)`);
    } else {
        console.log("No actions were attempted.");
    }
    if (contextualSuccesses.length > 0) {
      console.log(`  Successfully recovered with context (Second Pass): ${contextualSuccesses.length}`);
    }

    if (successes.length > 0) {
      console.log("\n✅ Successful Actions:");
      successes.forEach(result => {
        let notes = [];
        if (result.contextUsed) notes.push("Recovered in 2nd pass with context");
        if (result.attempts > 1 && !result.contextUsed) notes.push(`Succeeded on attempt ${result.attempts > this.maxRetriesPerAction ? result.attempts - this.maxRetriesPerAction : result.attempts } of 1st pass`);
        else if (result.attempts > 1 && result.contextUsed) notes.push (`Total attempts including 1st pass: ${result.attempts}`)

        const noteString = notes.length > 0 ? ` (${notes.join('; ')})` : "";
        console.log(`- ${result.actionTitle} (${result.modelName})${noteString}`);
         if (result.finalKnowledge !== result.originalKnowledge && result.success) {
            console.log(`  Succeeded with refined knowledge.`);
        }
      });
    }

    if (failures.length > 0) {
      console.log("\n❌ Failed Actions:");
      failures.forEach(result => {
        console.log(`- ${result.actionTitle} (${result.modelName})`);
        console.log(`  Error: ${result.error}`);
        console.log(`  Total Attempts: ${result.attempts}`);
         if (result.finalKnowledge !== result.originalKnowledge) {
            console.log(`  Failed with last attempted knowledge (original was refined).`);
        } else {
            console.log(`  Failed with original knowledge (no effective refinement or refinement disabled).`);
        }
      });
    }

    if (skipped.length > 0) {
      console.log("\n⏭️ Skipped Actions:");
      skipped.forEach(result => {
        console.log(`- ${result.actionTitle} (${result.modelName}): ${result.error}`);
      });
    }

    const actionsWithSuccessfulRefinements = results.filter(r => 
      r.success && r.finalKnowledge && r.finalKnowledge !== r.originalKnowledge
    );
    const actionsWithAttemptedRefinements = results.filter(r =>
        r.finalKnowledge && r.finalKnowledge !== r.originalKnowledge
    );

    if (actionsWithAttemptedRefinements.length > 0) {
      console.log("\n🔄 Knowledge Refinement Statistics:");
      console.log(`Actions where knowledge was refined at least once: ${actionsWithAttemptedRefinements.length}`);
      console.log(`  Successfully completed after refinement: ${actionsWithSuccessfulRefinements.length}`);
      if(actionsWithAttemptedRefinements.length > 0) {
        console.log(`  Success rate for actions that underwent refinement: ${
            Math.round(actionsWithSuccessfulRefinements.length / actionsWithAttemptedRefinements.length * 100)
        }%`);
      }
    }

    console.log("\n💡 Recommendations:");
    if (failures.length > 0) {
      console.log("- Review failed actions and their error messages. Check the last attempted knowledge.");
      console.log("- Consider manually updating the base knowledge for actions that consistently fail or require many refinements.");
    }
    if (skipped.length > 0) {
      console.log("- Provide knowledge documentation for all skipped actions to enable testing.");
    }
    if (contextualSuccesses.length > 0) {
      console.log("- Analyze actions recovered with context: their original knowledge might be missing dependency handling that context provided.");
    }
    if (actionsWithAttemptedRefinements.length > 0 && actionsWithSuccessfulRefinements.length < actionsWithAttemptedRefinements.length) {
        console.log("- Investigate why some knowledge refinements did not lead to success; the refinement logic or prompts might need tuning.");
    }


    const overallStatus = failures.length === 0 && totalAttempted > 0 ? 
      "✨ All attempted actions completed successfully!" : 
      (totalAttempted === 0 ? "🤷 No actions were attempted." : "⚠️ Some actions failed - review errors and knowledge.");
    console.log(`\n${overallStatus}`);
  }
}