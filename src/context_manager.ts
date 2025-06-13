import { ExecutionContext, ActionResult, ModelDefinition } from './interface';

export class ContextManager {
  private globalContext: ExecutionContext;
  private readonly maxRecentActions = 10;

  constructor() {
    this.globalContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableIds: new Map()
    };
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

  storePathParameters(pathTemplate: string, extractedData: any): void {
  if (!extractedData?.ids) return;
  
  const pathParams = pathTemplate.match(/\{\{(\w+)\}\}/g) || [];
  
  for (const param of pathParams) {
    const paramName = param.replace(/[{}]/g, '');
    
    if (extractedData.ids[paramName]) {
      if (!this.globalContext.availableIds.has(paramName)) {
        this.globalContext.availableIds.set(paramName, []);
      }
      const existingIds = this.globalContext.availableIds.get(paramName)!;
      if (!existingIds.includes(extractedData.ids[paramName])) {
        existingIds.push(extractedData.ids[paramName]);
        console.log(`[ContextManager] Storing path parameter: ${paramName} = ${extractedData.ids[paramName]}`);
      }
    }
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
        summary += "\nAvailable IDs in Context:\n"
        for(const [key, ids] of this.globalContext.availableIds.entries()) {
            summary += `- ${key}: ${ids.length} available\n`
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
      availableIds: new Map(this.globalContext.availableIds)
    };
    return newContext;
  }
  getContextForFailedActions(): ExecutionContext {
     const context = this.getContext();
     context.platformSummary = `${context.platformSummary}\n\nRetrying failed actions with full context from successful actions.`;
     return context;
  }

  reset(): void {
    this.globalContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableIds: new Map()
    };
  }
}