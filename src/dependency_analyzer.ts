import { ModelDefinition } from './interface';
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, LanguageModel } from "ai";
import { EnhancedModelSelector } from './enhanced_model_selector';
import { z } from 'zod';
import chalk from 'chalk';

const DependencyGraphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    actionName: z.string(),
    modelName: z.string(),
    dependsOn: z.array(z.string()).describe("IDs of actions this depends on"),
    providesIds: z.array(z.string()).describe("ID types this action provides (e.g., 'documentId')"),
    requiresIds: z.array(z.string()).describe("ID types this action requires"),
    priority: z.number().describe("Execution priority (1-10, lower first)"),
    canRetry: z.boolean().describe("Whether this action can be retried if it fails"),
    isOptional: z.boolean().describe("Whether this action is optional for the test suite")
  })),
  executionGroups: z.array(z.array(z.string())).describe("Groups of action IDs that can run in parallel")
});

type DependencyGraph = z.infer<typeof DependencyGraphSchema>;

export class EnhancedDependencyAnalyzer {
  private analysisModel: LanguageModel;
  
  constructor(private useClaudeForAnalysis: boolean = true) {
  if (useClaudeForAnalysis && process.env.ANTHROPIC_API_KEY) {
    try {
      this.analysisModel = anthropic("claude-sonnet-4-20250514");
    } catch (error) {
      console.warn("Failed to initialize Claude for analysis, falling back to GPT-4.1");
      this.analysisModel = openai("gpt-4.1");
    }
  } else {
    this.analysisModel = openai("gpt-4.1");
  }
}

  async analyzeDependencies(
    actions: ModelDefinition[],
    platformName: string
  ): Promise<DependencyGraph> {
    const systemPrompt = `You are an expert API dependency analyzer. Analyze the given actions and create a dependency graph.

ANALYSIS RULES:
1. CREATE actions usually provide IDs (documentId, spreadsheetId, etc.)
2. GET/UPDATE/DELETE actions usually require those IDs
3. LIST actions are often independent but may depend on CREATE for testing
4. Some actions may have implicit dependencies (e.g., adding sheet to spreadsheet)
5. Consider the action path - if it contains {{variableName}}, it requires that ID

IMPORTANT CONSIDERATIONS:
- UPDATE actions should depend on CREATE actions that create content, not just empty resources
- If a CREATE action creates an empty resource, consider adding a "add content" action before UPDATE
- DELETE actions should be last in the chain
- Batch operations might need multiple resources to be meaningful

PRIORITY GUIDELINES:
- Priority 1: Independent CREATE actions
- Priority 2: Dependent CREATE actions (e.g., create sheet in spreadsheet)
- Priority 3: LIST/SEARCH actions
- Priority 4: GET actions  
- Priority 5: UPDATE/PATCH actions
- Priority 6: DELETE actions
- Priority 7+: Complex dependent actions

Mark actions as optional if they're not critical for basic testing.
Group actions that can run in parallel (same priority, no interdependencies).`;
    const MAX_ACTIONS_PER_CHUNK = 35;
    if (actions.length > MAX_ACTIONS_PER_CHUNK) {
      console.log(chalk.yellow(`⚠️ Too many actions (${actions.length}). Using simplified analysis.`));
  return this.createFallbackGraph(actions);
}
    const userPrompt = `Platform: ${platformName}

Actions to analyze:
${actions.map(action => `
- ID: ${action._id}
  Title: ${action.title}
  Action: ${action.actionName}
  Path: ${action.path}
  Provides: ${this.inferProvidedIds(action).join(', ') || 'none'}
  Requires: ${this.inferRequiredIds(action).join(', ') || 'none'}
`).join('\n')}

Based on the actions above, create a complete dependency graph with execution priority and parallel execution groups.`;

    const fullPrompt = systemPrompt + userPrompt;
    const inputLength = fullPrompt.length;
    const modelToUse = EnhancedModelSelector.selectModel('dependency', inputLength, this.useClaudeForAnalysis);
    
    const model = modelToUse === 'claude-sonnet-4-20250514' ? 
      anthropic("claude-sonnet-4-20250514") : 
      openai(modelToUse);

    try {
      const { object: graph } = await generateObject({
        model,
        schema: DependencyGraphSchema,
        system: systemPrompt,
        prompt: userPrompt,
        maxRetries: 2,  
        temperature: 0.3  
      });

      return this.validateAndOptimizeGraph(graph, actions);
    } catch (error: any) {
  console.error('Error analyzing dependencies:', error);

  if (error.finishReason === 'length' || error.message?.includes('token')) {
    console.log(chalk.yellow('⚠️  AI analysis failed due to token limits.'));
  }

  console.log(chalk.blue('Falling back to rule-based dependency analysis...'));
  return this.createFallbackGraph(actions);
}
  }
  private validateAndOptimizeGraph(graph: DependencyGraph, actions: ModelDefinition[]): DependencyGraph {
    const actionIds = new Set(actions.map(a => a._id));
    const graphIds = new Set(graph.nodes.map(n => n.id));

    for (const action of actions) {
      if (!graphIds.has(action._id)) {
        console.warn(`AI analysis missed an action: "${action.title}". Adding with fallback logic.`);
        graph.nodes.push({
          id: action._id,
          actionName: action.actionName,
          modelName: action.modelName,
          dependsOn: [], 
          providesIds: this.inferProvidedIds(action),
          requiresIds: this.inferRequiredIds(action), 
          priority: this.getDefaultPriority(action),
          canRetry: true,
          isOptional: false 
        });
      }
    }

    for (const node of graph.nodes) {
      const actionDef = actions.find(a => a._id === node.id);
      if (actionDef) {
        const actualRequiredIds = this.inferRequiredIds(actionDef);
        if (JSON.stringify(node.requiresIds) !== JSON.stringify(actualRequiredIds)) {
            console.log(`Correcting dependencies for "${actionDef.title}": From [${node.requiresIds}] to [${actualRequiredIds}]`);
        }
        node.requiresIds = actualRequiredIds;
      }

      node.dependsOn = node.dependsOn.filter(id => {
        const dependencyExists = actionIds.has(id);
        if (!dependencyExists) {
            console.warn(`Node "${node.actionName}" had an invalid dependency on non-existent action ID: ${id}. Removing it.`);
        }
        return dependencyExists;
      });
    }

    this.detectAndBreakCircularDependencies(graph);

    graph.executionGroups = this.createOptimalExecutionGroups(graph);

    return graph;
  }
  private inferProvidedIds(action: ModelDefinition): string[] {
    const ids: string[] = [];
    const actionName = action.actionName.toLowerCase();
    const modelName = action.modelName.toLowerCase();
    
    if (actionName.includes('create')) {
      if (modelName.includes('document')) ids.push('documentId');
      if (modelName.includes('spreadsheet')) ids.push('spreadsheetId');
      if (modelName.includes('sheet')) ids.push('sheetId');
      if (modelName.includes('folder')) ids.push('folderId');
      if (modelName.includes('file')) ids.push('fileId');
      if (modelName.includes('email')) ids.push('messageId');
      if (modelName.includes('contact')) ids.push('contactId');
      if (modelName.includes('task')) ids.push('taskId');
      
      if (ids.length === 0) ids.push(`${modelName}Id`);
    }
    
    return ids;
  }

  private inferRequiredIds(action: ModelDefinition): string[] {
    const ids: string[] = [];
    const pathMatches = action.path.matchAll(/\{\{(\w+)\}\}/g);
    
    for (const match of pathMatches) {
      ids.push(match[1]);
    }
    
    return ids;
  }

  private getDefaultPriority(action: ModelDefinition): number {
    const actionName = action.actionName.toLowerCase();
    
    if (actionName.includes('create') && !action.path.includes('{{')) return 1;
    if (actionName.includes('create')) return 2;
    if (actionName.includes('list') || actionName.includes('search')) return 3;
    if (actionName.includes('get') || actionName.includes('retrieve')) return 4;
    if (actionName.includes('update') || actionName.includes('patch')) return 5;
    if (actionName.includes('delete') || actionName.includes('remove')) return 6;
    
    return 7;
  }

  private detectAndBreakCircularDependencies(graph: DependencyGraph): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      
      const node = graph.nodes.find(n => n.id === nodeId);
      if (!node) return false;
      
      for (const depId of node.dependsOn) {
        if (!visited.has(depId)) {
          if (hasCycle(depId)) return true;
        } else if (recursionStack.has(depId)) {
          console.log(`Breaking circular dependency: ${nodeId} -> ${depId}`);
          node.dependsOn = node.dependsOn.filter(id => id !== depId);
          return true;
        }
      }
      
      recursionStack.delete(nodeId);
      return false;
    };
    
    for (const node of graph.nodes) {
      if (!visited.has(node.id)) {
        hasCycle(node.id);
      }
    }
  }

  private createOptimalExecutionGroups(graph: DependencyGraph): string[][] {
    const groups: string[][] = [];
    const executed = new Set<string>();
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    
    while (executed.size < graph.nodes.length) {
      const currentGroup: string[] = [];
      
      for (const node of graph.nodes) {
        if (executed.has(node.id)) continue;
        
        const canExecute = node.dependsOn.every(depId => executed.has(depId));
        
        if (canExecute) {
          currentGroup.push(node.id);
        }
      }
      
      if (currentGroup.length === 0) {
        const remaining = graph.nodes
          .filter(n => !executed.has(n.id))
          .map(n => n.id);
        if (remaining.length > 0) {
          groups.push(remaining);
          remaining.forEach(id => executed.add(id));
        }
        break;
      }
      
      groups.push(currentGroup);
      currentGroup.forEach(id => executed.add(id));
    }
    
    return groups;
  }

  private createFallbackGraph(actions: ModelDefinition[]): DependencyGraph {
    const nodes = actions.map(action => ({
      id: action._id,
      actionName: action.actionName,
      modelName: action.modelName,
      dependsOn: [] as string[],
      providesIds: this.inferProvidedIds(action),
      requiresIds: this.inferRequiredIds(action),
      priority: this.getDefaultPriority(action),
      canRetry: true,
      isOptional: false
    }));

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.requiresIds.length > 0) {
        for (let j = 0; j < i; j++) {
          const provider = nodes[j];
          const hasRequired = node.requiresIds.some(reqId => 
            provider.providesIds.includes(reqId)
          );
          if (hasRequired) {
            node.dependsOn.push(provider.id);
          }
        }
      }
    }

    return {
      nodes,
      executionGroups: this.createOptimalExecutionGroups({ nodes, executionGroups: [] })
    };
  }

  getSortedActions(graph: DependencyGraph, actions: ModelDefinition[]): ModelDefinition[] {
    const actionMap = new Map(actions.map(a => [a._id, a]));
    const sorted: ModelDefinition[] = [];
    
    for (const group of graph.executionGroups) {
      const groupActions = group
        .map(id => actionMap.get(id))
        .filter((a): a is ModelDefinition => a !== undefined)
        .sort((a, b) => {
          const nodeA = graph.nodes.find(n => n.id === a._id);
          const nodeB = graph.nodes.find(n => n.id === b._id);
          return (nodeA?.priority || 10) - (nodeB?.priority || 10);
        });
      
      sorted.push(...groupActions);
    }
    
    return sorted;
  }

  getActionDependencies(actionId: string, graph: DependencyGraph): string[] {
    const node = graph.nodes.find(n => n.id === actionId);
    return node?.dependsOn || [];
  }

  getActionMetadata(actionId: string, graph: DependencyGraph) {
    return graph.nodes.find(n => n.id === actionId);
  }
}