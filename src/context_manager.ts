import { ExecutionContext, ActionResult, ModelDefinition } from './interface';

export class ContextManager {
  private globalContext: ExecutionContext;
  private readonly maxRecentActions = 10;

  constructor() {
    this.globalContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableNames: new Map(),
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

  storePathParameters(pathTemplate: string, extractedData: any): void {
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
        summary += "\nAvailable IDs in Context:\n"
        for(const [key, ids] of this.globalContext.availableIds.entries()) {
            summary += `- ${key}: ${ids.length} available\n`
        }
    }

    if (this.globalContext.availableNames && this.globalContext.availableNames.size > 0) {
        summary += "\nAvailable Names in Context:\n"
        for(const [key, name] of this.globalContext.availableNames.entries()) {
            summary += `- ${key}: "${name}"\n`
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

  reset(): void {
    this.globalContext = {
      platformSummary: "",
      recentActions: [],
      createdResources: new Map(),
      availableIds: new Map(),
      availableNames: new Map()
    };
  }
}