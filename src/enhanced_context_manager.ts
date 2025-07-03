import { ModelDefinition, ExecutionContext, ActionResult } from './interface';
import { PromptGenerationContext } from './interface';
import { PlatformUseCaseAnalyzer } from './platform_usecase_analyzer';
import chalk from 'chalk';

export class EnhancedContextManager {
  private globalContext: ExecutionContext;
  private readonly maxRecentActions = 10;
  private platformAnalyzer: PlatformUseCaseAnalyzer;
  private conversationHistory: {
    prompts: string[];
    responses: string[];
    extractedData: any[];
    conversationFlow: string;
  } = {
    prompts: [],
    responses: [],
    extractedData: [],
    conversationFlow: ""
  };

  constructor(useClaudeForAnalysis: boolean = true) {
    this.globalContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableNames: new Map(),
      availableIds: new Map()
    };
    this.platformAnalyzer = new PlatformUseCaseAnalyzer(useClaudeForAnalysis);
  }

  updateContext(action: ModelDefinition, result: ActionResult, extractedData?: any): void {
    this.globalContext.recentActions.push({
      actionTitle: action.title,
      modelName: action.modelName,
      success: result.success,
      output: result.output, 
      error: result.error
    });

    if (this.globalContext.recentActions.length > this.maxRecentActions) {
      this.globalContext.recentActions = this.globalContext.recentActions.slice(-this.maxRecentActions);
    }

    if (result.success && extractedData) {
      if (extractedData.created_resources) {
        for (const [key, value] of Object.entries(extractedData.created_resources)) {
          console.log(`[ContextManager] Storing created resource: ${key}`);
          this.globalContext.createdResources.set(key, value);
        }
      }

      if (extractedData.names) {
        for (const [key, name] of Object.entries(extractedData.names)) {
          if (typeof name === 'string') {
            console.log(`[ContextManager] Storing name: ${key} = ${name}`);
            const idKey = key.replace('Name', 'Id');
            if (!this.globalContext.availableNames) {
              this.globalContext.availableNames = new Map();
            }
            this.globalContext.availableNames.set(idKey, name);
            this.globalContext.availableNames.set(key, name);
          }
        }
      }

      if (extractedData.emails && extractedData.emails.length > 0) {
        console.log(`[ContextManager] Storing emails: ${extractedData.emails.join(', ')}`);
        this.globalContext.createdResources.set('emails', extractedData.emails);
      }

      if (extractedData.phones && extractedData.phones.length > 0) {
        console.log(`[ContextManager] Storing phones: ${extractedData.phones.join(', ')}`);
        this.globalContext.createdResources.set('phones', extractedData.phones);
      }

      if (extractedData.metadata && Object.keys(extractedData.metadata).length > 0) {
        console.log(`[ContextManager] Storing metadata:`, extractedData.metadata);
        for (const [key, value] of Object.entries(extractedData.metadata)) {
          this.globalContext.createdResources.set(`metadata_${key}`, value);
        }
      }

      if (extractedData.ids) {
        for (const [key, id] of Object.entries(extractedData.ids)) {
          if (typeof id === 'string') {
            if (!this.globalContext.availableIds.has(key)) {
              this.globalContext.availableIds.set(key, []);
            }
            console.log(`[ContextManager] Storing ID: ${key} = ${id}`);
            this.globalContext.availableIds.get(key)!.push(id);
          }
        }
      }

      this.storePathParameters(action.path, extractedData);

      if (extractedData.extracted_lists) {
        for (const [key, list] of Object.entries(extractedData.extracted_lists)) {
          console.log(`[ContextManager] Storing extracted list: ${key}`);
          this.globalContext.createdResources.set(key, list);
        }
      }
    }

    this.updatePlatformSummary();
  }

  private storePathParameters(pathTemplate: string, extractedData: any): void {
    if (!extractedData?.ids) return;
    
    const templateParams = pathTemplate.match(/\{\{(\w+)\}\}/g) || [];
    const colonParams = pathTemplate.match(/:(\w+)/g) || [];
    
    const allParams = [
      ...templateParams.map(p => p.replace(/[{}]/g, '')),
      ...colonParams.map(p => p.substring(1))
    ];
    
    for (const paramName of allParams) {
      if (extractedData.ids[paramName]) {
        this.storeId(paramName, extractedData.ids[paramName]);
      }
      else if (extractedData.ids[paramName + 'Id']) {
        this.storeId(paramName, extractedData.ids[paramName + 'Id']);
        this.storeId(paramName + 'Id', extractedData.ids[paramName + 'Id']);
      }
      else if (paramName.endsWith('Id')) {
        const baseParam = paramName.slice(0, -2);
        if (extractedData.ids[baseParam]) {
          this.storeId(paramName, extractedData.ids[baseParam]);
          this.storeId(baseParam, extractedData.ids[baseParam]);
        }
      }
    }
  }

  private storeId(key: string, value: string): void {
    if (!this.globalContext.availableIds.has(key)) {
      this.globalContext.availableIds.set(key, []);
    }
    const existingIds = this.globalContext.availableIds.get(key)!;
    if (!existingIds.includes(value)) {
      existingIds.push(value);
      console.log(`[ContextManager] Storing ID: ${key} = ${value}`);
    }
  }

  private updatePlatformSummary(): void {
    const recentSuccesses = this.globalContext.recentActions
      .filter(action => action.success)
      .slice(-5);
    
    const recentFailures = this.globalContext.recentActions
      .filter(action => !action.success)
      .slice(-3);

    let summary = "Platform Testing Progress:\n";
    
    if (recentSuccesses.length > 0) {
      summary += "Recent Successful Actions:\n";
      recentSuccesses.forEach(action => {
        summary += `- ${action.actionTitle} (${action.modelName})\n`;
      });
    }

    if (recentFailures.length > 0) {
      summary += "Recent Failed Actions:\n";
      recentFailures.forEach(action => {
        summary += `- ${action.actionTitle} (${action.modelName}): ${action.error}\n`;
      });
    }
    
    if (this.globalContext.availableIds.size > 0) {
      summary += "\nAvailable IDs in Context:\n";
      for (const [key, ids] of this.globalContext.availableIds.entries()) {
        summary += `- ${key}: ${ids.length} available\n`;
      }
    }

    if (this.globalContext.availableNames && this.globalContext.availableNames.size > 0) {
      summary += "\nAvailable Names in Context:\n";
      for (const [key, name] of this.globalContext.availableNames.entries()) {
        summary += `- ${key}: "${name}"\n`;
      }
    }

    if (this.globalContext.createdResources.size > 0) {
      summary += `\nCreated Resources in Context: ${Array.from(this.globalContext.createdResources.keys()).join(', ')}`;
    }

    this.globalContext.platformSummary = summary;
  }

  getContext(): ExecutionContext {
    const newContext: ExecutionContext = {
      platformSummary: this.globalContext.platformSummary,
      recentActions: [...this.globalContext.recentActions],
      createdResources: new Map(this.globalContext.createdResources),
      availableIds: new Map(this.globalContext.availableIds),
      availableNames: new Map(this.globalContext.availableNames)
    };
    return newContext;
  }

  getContextForFailedActions(): ExecutionContext {
    const context = this.getContext();
    context.platformSummary = `${context.platformSummary}\n\nRetrying failed actions with full context from successful actions.`;
    return context;
  }

  async buildPromptGenerationContext(
    action: ModelDefinition,
    dependencyGraph: any,
    attemptNumber: number = 1,
    previousError?: string,
    actions?: ModelDefinition[]
  ): Promise<PromptGenerationContext> {
    console.log(chalk.blue(`   🔧 Building prompt generation context for: ${action.title}`));

    const executionContext = this.getContext();

    let platformProfile;
    if (actions && actions.length > 0) {
      platformProfile = await this.platformAnalyzer.analyzePlatform(
        action.connectionPlatform,
        actions
      );
    }

    const dependencyContext = this.buildDependencyContext(action, dependencyGraph);

    const platformContext = {
      platform: action.connectionPlatform,
      terminology: this.platformAnalyzer.getTerminologyMap(action.connectionPlatform),
      useCase: platformProfile?.primaryUseCase.name || this.inferUseCaseFromAction(action),
      scenario: this.platformAnalyzer.getUseCaseForAction(action.connectionPlatform, action),
      businessContext: this.platformAnalyzer.generateBusinessContext(action.connectionPlatform)
    };

    const conversationFlow = this.buildConversationFlow(action, executionContext);

    const metadata = {
      attemptNumber,
      previousError,
      isRetry: attemptNumber > 1,
      totalActionsInSequence: dependencyGraph?.nodes?.length || 1,
      currentActionIndex: this.findActionIndex(action, dependencyGraph)
    };

    const context: PromptGenerationContext = {
      executionContext,
      dependencies: dependencyContext,
      conversationHistory: {
        previousPrompts: [...this.conversationHistory.prompts],
        previousResponses: [...this.conversationHistory.responses],
        extractedData: [...this.conversationHistory.extractedData],
        conversationFlow: conversationFlow
      },
      platformContext,
      metadata
    };

    console.log(chalk.green(`   ✅ Context built - ${context.executionContext.availableIds?.size || 0} IDs available`));
    
    return context;
  }

  private buildDependencyContext(action: ModelDefinition, dependencyGraph: any) {
    const actionNode = dependencyGraph?.nodes?.find((n: any) => n.id === action._id);
    
    const context = this.getContext();
    const availableResources = new Map();
    
    if (context.availableIds) {
      for (const [key, values] of context.availableIds.entries()) {
        availableResources.set(key, values);
      }
    }
    
    if (context.createdResources) {
      for (const [key, resource] of context.createdResources.entries()) {
        availableResources.set(key, resource);
      }
    }

    return {
      graph: dependencyGraph,
      currentAction: action,
      completedDependencies: this.getCompletedDependencies(action, dependencyGraph),
      availableResources,
      requiredIds: actionNode?.requiresIds || [],
      providedIds: actionNode?.providesIds || []
    };
  }

  private getCompletedDependencies(action: ModelDefinition, dependencyGraph: any): Set<string> {
    const completed = new Set<string>();
    const actionNode = dependencyGraph?.nodes?.find((n: any) => n.id === action._id);
    
    if (actionNode?.dependsOn) {
      const context = this.getContext();
      
      for (const depId of actionNode.dependsOn) {
        const depNode = dependencyGraph.nodes.find((n: any) => n.id === depId);
        if (depNode) {
          const hasProvidedIds = depNode.providesIds.some((id: string) => 
            context.availableIds?.has(id)
          );
          
          if (hasProvidedIds) {
            completed.add(depId);
          }
        }
      }
    }
    
    return completed;
  }

  private buildConversationFlow(action: ModelDefinition, context: ExecutionContext): string {
    const recentActions = context.recentActions.slice(-3);
    
    if (recentActions.length === 0) {
      return `Starting ${action.connectionPlatform} workflow with ${action.title}`;
    }

    const actionSummary = recentActions
      .map(a => `${a.success ? '✅' : '❌'} ${a.actionTitle}`)
      .join(' → ');

    const availableResourcesCount = context.availableIds?.size || 0;
    const hasNames = context.availableNames && context.availableNames.size > 0;

    let flow = `Continuing workflow: ${actionSummary}. `;
    
    if (availableResourcesCount > 0) {
      flow += `We now have ${availableResourcesCount} resources created`;
      if (hasNames) {
        const nameExamples = Array.from(context.availableNames!.values()).slice(0, 2);
        flow += ` including ${nameExamples.join(' and ')}`;
      }
      flow += '. ';
    }

    flow += `Next: ${action.title}.`;
    
    return flow;
  }

  private findActionIndex(action: ModelDefinition, dependencyGraph: any): number {
    if (!dependencyGraph?.executionGroups) return 0;
    
    let index = 0;
    for (const group of dependencyGraph.executionGroups) {
      if (group.includes(action._id)) {
        return index;
      }
      index += group.length;
    }
    
    return index;
  }

  private inferUseCaseFromAction(action: ModelDefinition): string {
    const modelName = action.modelName.toLowerCase();
    
    if (modelName.includes('contact') || modelName.includes('deal') || modelName.includes('lead')) {
      return "Customer Relationship Management (CRM)";
    } else if (modelName.includes('project') || modelName.includes('issue') || modelName.includes('task')) {
      return "Project Management";
    } else if (modelName.includes('product') || modelName.includes('order') || modelName.includes('inventory')) {
      return "E-commerce";
    } else if (modelName.includes('document') || modelName.includes('file') || modelName.includes('sheet')) {
      return "Document Management";
    } else {
      return "Data Management";
    }
  }

  recordPrompt(prompt: string): void {
    this.conversationHistory.prompts.push(prompt);
    this.updateConversationFlow();
  }

  recordResponse(response: string, extractedData?: any): void {
    this.conversationHistory.responses.push(response);
    if (extractedData) {
      this.conversationHistory.extractedData.push(extractedData);
    }
    this.updateConversationFlow();
  }

  private updateConversationFlow(): void {
    const promptCount = this.conversationHistory.prompts.length;
    
    if (promptCount === 0) {
      this.conversationHistory.conversationFlow = "Starting conversation";
    } else if (promptCount === 1) {
      this.conversationHistory.conversationFlow = "First action in sequence";
    } else {
      const lastPrompt = this.conversationHistory.prompts[promptCount - 1];
      const actionType = this.extractActionType(lastPrompt);
      this.conversationHistory.conversationFlow = `Continuing workflow after ${actionType}`;
    }
  }

  private extractActionType(prompt: string): string {
    const lower = prompt.toLowerCase();
    if (lower.includes('create') || lower.includes('add')) return 'creation';
    if (lower.includes('update') || lower.includes('edit') || lower.includes('modify')) return 'update';
    if (lower.includes('delete') || lower.includes('remove')) return 'deletion';
    if (lower.includes('show') || lower.includes('list') || lower.includes('get')) return 'retrieval';
    return 'action';
  }

  getContextSummary(): string {
    const context = this.getContext();
    const parts = [];
    
    if (context.availableIds && context.availableIds.size > 0) {
      parts.push(`${context.availableIds.size} resources available`);
    }
    
    if (context.recentActions.length > 0) {
      const successCount = context.recentActions.filter(a => a.success).length;
      parts.push(`${successCount}/${context.recentActions.length} recent actions successful`);
    }
    
    if (this.conversationHistory.prompts.length > 0) {
      parts.push(`${this.conversationHistory.prompts.length} prompts in conversation`);
    }
    
    return parts.join(', ') || 'Empty context';
  }

  hasRequiredContext(requiredIds: string[]): boolean {
    const context = this.getContext();
    if (!context.availableIds) return false;
    
    return requiredIds.every(id => context.availableIds!.has(id));
  }

  getMissingContext(requiredIds: string[]): string[] {
    const context = this.getContext();
    if (!context.availableIds) return requiredIds;
    
    return requiredIds.filter(id => !context.availableIds!.has(id));
  }

  getAvailableContextForPrompt(): string {
    const context = this.getContext();
    const parts = [];
    
    if (context.availableNames && context.availableNames.size > 0) {
      const names = Array.from(context.availableNames.entries())
        .map(([key, name]) => `${key}: "${name}"`)
        .slice(0, 3); // Show first 3
      parts.push(`Names: ${names.join(', ')}`);
    }
    
    if (context.availableIds && context.availableIds.size > 0) {
      const idCount = context.availableIds.size;
      parts.push(`${idCount} IDs available`);
    }
    
    return parts.join('; ') || 'No context available';
  }

  resetConversationHistory(): void {
    this.conversationHistory = {
      prompts: [],
      responses: [],
      extractedData: [],
      conversationFlow: ""
    };
  }

  reset(): void {
    this.globalContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableIds: new Map(),
      availableNames: new Map()
    };
    this.resetConversationHistory();
  }
}
