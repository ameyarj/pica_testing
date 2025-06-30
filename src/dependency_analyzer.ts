import { ModelDefinition } from './interface';
import { generateObject, LanguageModel } from "ai";
import { ApiDocAnalyzer } from './api_doc_analyzer';
import { z } from 'zod';
import chalk from 'chalk';
import { initializeModel } from './utils/modelInitializer';

interface ChunkResult {
  nodes: any[];
  internalDependencies: Map<string, string[]>;
  externalRequirements: Map<string, string[]>;
  externalProvisions: Map<string, string[]>;
}

const DependencyGraphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    actionName: z.string(),
    modelName: z.string(),
    dependsOn: z.array(z.string()).describe("IDs of actions this depends on"),
    providesIds: z.array(z.string()).describe("ID types this action provides (e.g., 'documentId')"),
    providesNames: z.array(z.string()).describe("Name types this action provides (e.g., 'documentName')"),
    providesEmails: z.array(z.string()).describe("Email types this action provides"),
    providesPhones: z.array(z.string()).describe("Phone types this action provides"),
    requiresIds: z.array(z.string()).describe("ID types this action requires"),
    requiresNames: z.array(z.string()).describe("Name types this action requires"),
    requiresEmails: z.array(z.string()).describe("Email types this action requires"),
    requiresPhones: z.array(z.string()).describe("Phone types this action requires"),
    priority: z.number().describe("Execution priority (1-10, lower first)"),
    canRetry: z.boolean().describe("Whether this action can be retried if it fails"),
    isOptional: z.boolean().describe("Whether this action is optional for the test suite")
  })),
  executionGroups: z.array(z.array(z.string())).describe("Groups of action IDs that can run in parallel")
});

type DependencyGraph = z.infer<typeof DependencyGraphSchema>;

export class EnhancedDependencyAnalyzer {
  private analysisModel: LanguageModel;
  private apiDocAnalyzer: ApiDocAnalyzer;
  
  constructor(private useClaudeForAnalysis: boolean = true) {
  this.analysisModel = initializeModel(useClaudeForAnalysis, 'dependency-analyzer');
  
  this.apiDocAnalyzer = new ApiDocAnalyzer();
}

  async analyzeDependencies(
  actions: ModelDefinition[],
  platformName: string,
  useApiDocs: boolean = false
): Promise<DependencyGraph> {
  if (useApiDocs && process.env.OPENAI_API_KEY) {
    console.log(chalk.blue(`📚 Enhancing dependency analysis with API documentation...`));
    await this.enhanceActionsWithApiDocs(actions.slice(0, 5), platformName); 
  }
  
  const CHUNK_SIZE = 15; 
  
  if (actions.length <= CHUNK_SIZE) {
    return this.analyzeActionsDirectly(actions, platformName);
  }
  
  console.log(chalk.blue(`📊 Large action set (${actions.length}). Using divide-and-conquer approach...`));
  
  const chunks = this.chunkActions(actions, CHUNK_SIZE);
  const chunkResults = await this.analyzeChunks(chunks, platformName);
  
  const mergedGraph = this.mergeChunkResults(chunkResults, actions);
  
  return this.resolveCrossChunkDependencies(mergedGraph, actions);
}

private async enhanceActionsWithApiDocs(
  actions: ModelDefinition[],
  platformName: string
): Promise<void> {
  for (const action of actions) {
    try {
      const apiDoc = await this.apiDocAnalyzer.searchApiDocumentation(action, platformName);
      
      if (apiDoc) {
        const enhancedKnowledge = await this.apiDocAnalyzer.enhanceActionKnowledge(action, apiDoc);
        action.knowledge = enhancedKnowledge;
        
        const requiredParams = this.apiDocAnalyzer.getRequiredParameters(apiDoc);
        
        (action as any)._enhancedParams = requiredParams;
      }
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️ Could not fetch API docs for ${action.title}`));
    }
  }
}

private chunkActions(actions: ModelDefinition[], chunkSize: number): ModelDefinition[][] {
  const chunks: ModelDefinition[][] = [];
  for (let i = 0; i < actions.length; i += chunkSize) {
    chunks.push(actions.slice(i, i + chunkSize));
  }
  return chunks;
}

private async analyzeChunks(
  chunks: ModelDefinition[][],
  platformName: string
): Promise<ChunkResult[]> {
  const results: ChunkResult[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(chalk.gray(`   Analyzing chunk ${i + 1}/${chunks.length}...`));
    const chunkGraph = await this.analyzeActionsDirectly(chunks[i], platformName);
    
    const chunkResult: ChunkResult = {
      nodes: chunkGraph.nodes,
      internalDependencies: new Map(),
      externalRequirements: new Map(),
      externalProvisions: new Map()
    };
    
    for (const node of chunkGraph.nodes) {
      const chunkIds = new Set(chunks[i].map(a => a._id));
      const internal = node.dependsOn.filter(id => chunkIds.has(id));
      const external = node.dependsOn.filter(id => !chunkIds.has(id));
      
      if (internal.length > 0) {
        chunkResult.internalDependencies.set(node.id, internal);
      }
      if (external.length > 0) {
        chunkResult.externalRequirements.set(node.id, external);
      }
      
      if (node.providesIds.length > 0) {
        chunkResult.externalProvisions.set(node.id, node.providesIds);
      }
    }
    
    results.push(chunkResult);
  }
  
  return results;
}

private async analyzeActionsDirectly(
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

  const userPrompt = `Platform: ${platformName}

Actions to analyze:
${actions.map(action => `
- ID: ${action._id}
  Title: ${action.title}
  Action: ${action.actionName}
  Path: ${action.path}
  Provides: ${this.inferProvidedData(action).join(', ') || 'none'}
  Requires: ${this.inferRequiredData(action).join(', ') || 'none'}
`).join('\n')}

Based on the actions above, create a complete dependency graph with execution priority and parallel execution groups.`;

  try {
    const { object: graph } = await generateObject({
      model: this.analysisModel,
      schema: DependencyGraphSchema,
      system: systemPrompt,
      prompt: userPrompt,
      maxRetries: 2,
      temperature: 0.3
    });

    return this.validateAndOptimizeGraph(graph, actions);
  } catch (error: any) {
    console.error('Error in chunk analysis:', error);
    return this.createFallbackGraph(actions);
  }
}

private mergeChunkResults(
  chunkResults: ChunkResult[],
  allActions: ModelDefinition[]
): DependencyGraph {
  const allNodes: any[] = [];
  const globalDependencies = new Map<string, string[]>();
  
  for (const chunk of chunkResults) {
    allNodes.push(...chunk.nodes);
    
    for (const [nodeId, deps] of chunk.internalDependencies) {
      globalDependencies.set(nodeId, deps);
    }
  }
  
  return {
    nodes: allNodes,
    executionGroups: [] 
  };
}

private async resolveCrossChunkDependencies(
  mergedGraph: DependencyGraph,
  allActions: ModelDefinition[]
): Promise<DependencyGraph> {
  const provisionMap = new Map<string, string[]>();
  for (const node of mergedGraph.nodes) {
    for (const providedId of node.providesIds) {
      if (!provisionMap.has(providedId)) {
        provisionMap.set(providedId, []);
      }
      provisionMap.get(providedId)!.push(node.id);
    }
  }
  
  for (const node of mergedGraph.nodes) {
    const resolvedDeps = new Set<string>(node.dependsOn);
    
    for (const requiredId of node.requiresIds) {
      const providers = provisionMap.get(requiredId) || [];
      for (const providerId of providers) {
        if (providerId !== node.id) {
          resolvedDeps.add(providerId);
        }
      }
    }
    
    node.dependsOn = Array.from(resolvedDeps);
  }
  
  mergedGraph.executionGroups = this.createOptimalExecutionGroups(mergedGraph);
  
  return mergedGraph;
}
  private validateAndOptimizeGraph(graph: DependencyGraph, actions: ModelDefinition[]): DependencyGraph {
    const actionIds = new Set(actions.map(a => a._id));
    const graphIds = new Set(graph.nodes.map(n => n.id));

    for (const action of actions) {
  if (!graphIds.has(action._id)) {
    console.warn(`AI analysis missed an action: "${action.title}". Adding with fallback logic.`);
    
    const providedData = this.inferProvidedData(action);
    const requiredData = this.inferRequiredData(action);
    
    graph.nodes.push({
      id: action._id,
      actionName: action.actionName,
      modelName: action.modelName,
      dependsOn: [], 
      providesIds: providedData.filter(d => d.endsWith('Id')),
      providesNames: providedData.filter(d => d.endsWith('Name')),
      providesEmails: providedData.filter(d => d.includes('email') || d.includes('Email')),
      providesPhones: providedData.filter(d => d.includes('phone') || d.includes('Phone')),
      requiresIds: requiredData.filter(d => d.endsWith('Id')),
      requiresNames: requiredData.filter(d => d.endsWith('Name')),
      requiresEmails: requiredData.filter(d => d.includes('email') || d.includes('Email')),
      requiresPhones: requiredData.filter(d => d.includes('phone') || d.includes('Phone')),
      priority: this.getDefaultPriority(action),
      canRetry: true,
      isOptional: false 
    });
  }
}

    for (const node of graph.nodes) {
    const actionDef = actions.find(a => a._id === node.id);
    if (actionDef) {
      const actualRequiredData = this.inferRequiredData(actionDef);
      const actualProvidedData = this.inferProvidedData(actionDef);
      
      node.requiresIds = actualRequiredData.filter(d => d.endsWith('Id'));
      node.requiresNames = actualRequiredData.filter(d => d.endsWith('Name'));
      node.requiresEmails = actualRequiredData.filter(d => d.includes('email') || d.includes('Email'));
      node.requiresPhones = actualRequiredData.filter(d => d.includes('phone') || d.includes('Phone'));
      
      node.providesIds = actualProvidedData.filter(d => d.endsWith('Id'));
      node.providesNames = actualProvidedData.filter(d => d.endsWith('Name'));
      node.providesEmails = actualProvidedData.filter(d => d.includes('email') || d.includes('Email'));
      node.providesPhones = actualProvidedData.filter(d => d.includes('phone') || d.includes('Phone'));
    }
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

  private inferProvidedData(action: ModelDefinition): string[] {
  const data: string[] = [];
  const actionName = action.actionName.toLowerCase();
  const modelName = action.modelName.toLowerCase();
  
  data.push(...this.inferProvidedIds(action));
  
  if (actionName.includes('create') || actionName.includes('update')) {
    if (modelName.includes('document')) data.push('documentName');
    if (modelName.includes('spreadsheet')) data.push('spreadsheetName');
    if (modelName.includes('contact')) data.push('contactName');
    if (modelName.includes('user')) data.push('userName');
  }
  
  if (modelName.includes('contact') || modelName.includes('user') || modelName.includes('email')) {
    if (actionName.includes('create')) data.push('email', 'contactEmail');
  }
  
  if (modelName.includes('contact') || modelName.includes('user')) {
    if (actionName.includes('create')) data.push('phone', 'contactPhone');
  }
  
  return data;
}

private inferRequiredData(action: ModelDefinition): string[] {
  const data: string[] = [];
  
  data.push(...this.inferRequiredIds(action));
  
  const knowledge = action.knowledge.toLowerCase();
  
  if (knowledge.includes('email') && !action.actionName.toLowerCase().includes('create')) {
    data.push('email');
  }
  
  if (knowledge.includes('phone') && !action.actionName.toLowerCase().includes('create')) {
    data.push('phone');
  }
  
  if (knowledge.includes('name') && action.actionName.toLowerCase().includes('search')) {
    data.push('name');
  }
  
  return data;
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
      providesNames: [] as string[],
      providesEmails: [] as string[],
      providesPhones: [] as string[],
      requiresIds: this.inferRequiredIds(action),
      requiresNames: [] as string[],
      requiresEmails: [] as string[],
      requiresPhones: [] as string[],
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
