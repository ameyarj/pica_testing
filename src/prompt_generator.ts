import { generateObject } from "ai";
import { z } from 'zod';
import { ModelDefinition, ExecutionContext } from './interfaces/interface';
import { LanguageModel } from "ai";
import { 
  PromptGenerationContext, 
  LLMPromptGenerationResponse,
  PromptPattern,
  PromptLearningData,
  PromptStrategy 
} from './interfaces/interface';
import { initializeModel } from './utils/modelInitializer';
import { trackLLMCall } from './utils/tokenTrackerUtils';
import { EnhancedContextManager } from './enhanced_context_manager';
import chalk from 'chalk';

const PromptGenerationSchema = z.object({
  prompt: z.string().describe("Natural, conversational prompt that a real user would type"),
  confidence: z.number().min(0).max(1).describe("Confidence in the prompt quality (0-1)"),
  reasoning: z.string().describe("Brief explanation of why this prompt was chosen"),
  alternativePrompts: z.array(z.string()).describe("2-3 alternative prompts for variety"),
  contextUsed: z.array(z.string()).describe("List of context elements that were incorporated"),
  suggestedTestData: z.record(z.any()).describe("Realistic test data that should be used")
});

export class EnhancedPromptGenerator {
  private llmModel: LanguageModel;
  private promptHistory: Map<string, { prompt: string; success: boolean }[]> = new Map();
  private enhancedContextManager: EnhancedContextManager;
  
  private promptPatterns: Map<string, PromptPattern> = new Map();
  private learningData: PromptLearningData[] = [];
  private platformTerminology: Map<string, Map<string, string>> = new Map();

  constructor(private useClaudeForPrompting: boolean = true) {
    this.llmModel = initializeModel(useClaudeForPrompting, 'prompt-generator');
    this.enhancedContextManager = new EnhancedContextManager(useClaudeForPrompting);
    this.initializePlatformTerminology();
  }

  private getNaturalActionVerb(actionName: string): string {
    const action = actionName.toLowerCase();
    
    if (action.includes('create') || action.includes('add')) return 'create';
    if (action.includes('update') || action.includes('edit') || action.includes('modify')) return 'update';
    if (action.includes('delete') || action.includes('remove')) return 'delete';
    if (action.includes('get') || action.includes('retrieve') || action.includes('fetch')) return 'get';
    if (action.includes('list') || action.includes('search')) return 'list';
    if (action.includes('custom')) return 'execute';
    
    return action; 
  }

  async generateHumanLikePrompt(
    action: ModelDefinition,
    context: ExecutionContext,
    dependencyGraph?: any,
    attemptNumber: number = 1,
    previousError?: string,
    allActions?: ModelDefinition[]
  ): Promise<{ prompt: string; strategy: PromptStrategy; confidence: number; reasoning: string }> {
    console.log(chalk.cyan(`   🤖 Generating human-like prompt for: ${action.title}`));

    try {
      const promptContext = await this.enhancedContextManager.buildPromptGenerationContext(
        action,
        dependencyGraph,
        attemptNumber,
        previousError,
        allActions
      );

      this.enhancedContextManager.recordPrompt(
        `About to generate prompt for ${action.title}`
      );

      const llmResponse = await this.generateHumanPrompt(
        action,
        promptContext,
        'conversational',
        'friendly'
      );

      if (llmResponse.confidence > 0.7) {
        this.recordPromptSuccess(
          llmResponse.prompt,
          action,
          promptContext,
          0 
        );
      }

      const strategy: PromptStrategy = {
        tone: 'conversational',
        emphasis: ['natural user language', 'use context naturally', 'realistic business scenario'],
        examples: llmResponse.alternativePrompts.length > 0,
        contextLevel: promptContext.executionContext.availableIds?.size > 0 ? 'extensive' : 'minimal'
      };

      let enhancedPrompt = llmResponse.prompt;
      
      if (attemptNumber > 1 || previousError) {
        enhancedPrompt += `\n\n---\n### Technical Context\n${action.knowledge}`;
        enhancedPrompt += `\n\n### Action ID\nUse Action ID: ${action._id}`;
      } else {
        enhancedPrompt += `\n\n(Use action: ${action.title})`;
      }

      console.log(chalk.green(`   ✅ Generated human prompt with ${llmResponse.confidence}% confidence`));
      console.log(chalk.gray(`   💡 Reasoning: ${llmResponse.reasoning}`));

      return {
        prompt: enhancedPrompt,
        strategy,
        confidence: llmResponse.confidence,
        reasoning: llmResponse.reasoning
      };

    } catch (error) {
      console.error(chalk.red(`   ❌ Error generating human-like prompt: ${error}`));
      
      const resourceName = action.title.toLowerCase();
      const actionVerb = this.getNaturalActionVerb(action.actionName);
      const fallbackPrompt = `Please help me ${actionVerb} a ${resourceName} using ${action.connectionPlatform}.\n\n${action.knowledge}\n\nUse Action ID: ${action._id}`;
      
      const fallbackStrategy: PromptStrategy = {
        tone: 'technical',
        emphasis: ['execute action'],
        examples: false,
        contextLevel: 'minimal'
      };

      return {
        prompt: fallbackPrompt,
        strategy: fallbackStrategy,
        confidence: 0.5,
        reasoning: "Fallback prompt due to LLM generation error"
      };
    }
  }

  async generateHumanPrompt(
    action: ModelDefinition,
    context: PromptGenerationContext,
    style: 'conversational' | 'business' | 'technical' | 'casual' = 'conversational',
    tone: 'friendly' | 'professional' | 'direct' | 'enthusiastic' = 'friendly'
  ): Promise<LLMPromptGenerationResponse> {
    console.log(chalk.blue(`   🤖 Generating human-like prompt for: ${action.title}`));

    const systemPrompt = this.buildSystemPrompt(context, style, tone);
    const userPrompt = this.buildUserPrompt(action, context);

    try {
      const response = await trackLLMCall(
        this.useClaudeForPrompting ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
        systemPrompt,
        userPrompt,
        'prompt-generator',
        'generate-human-prompt',
        async () => {
          const result = await generateObject({
            model: this.llmModel,
            schema: PromptGenerationSchema,
            system: systemPrompt,
            prompt: userPrompt,
            temperature: 0.7, 
          });
          return { result: result.object, outputText: JSON.stringify(result.object) };
        }
      );

      console.log(chalk.green(`   ✅ Generated prompt: "${response.prompt.substring(0, 80)}..."`));
      
      return {
        prompt: response.prompt,
        confidence: response.confidence,
        reasoning: response.reasoning,
        alternativePrompts: response.alternativePrompts,
        contextUsed: response.contextUsed,
        suggestedTestData: response.suggestedTestData
      };

    } catch (error) {
      console.error(chalk.red(`   ❌ Error generating prompt: ${error}`));
      return this.generateFallbackPrompt(action, context);
    }
  }

  private buildSystemPrompt(
    context: PromptGenerationContext,
    style: string,
    tone: string
  ): string {
    const platform = context.platformContext.platform;
    const useCase = context.platformContext.useCase;
    
    return `You are a real user of ${platform}, a ${useCase} platform. Generate natural prompts that actual users would type.

CRITICAL PLATFORM REQUIREMENT:
🚨 EVERY GENERATED PROMPT MUST EXPLICITLY MENTION "${platform}" TO ENSURE CORRECT PLATFORM SELECTION 🚨
This is essential because the user may have multiple platforms connected, and the agent must use the correct one.

CRITICAL CONTEXT AWARENESS:
${this.buildContextSection(context)}

PLATFORM KNOWLEDGE:
- Platform: ${platform}
- Use Case: ${useCase}
- Business Context: ${context.platformContext.businessContext}
- Terminology: ${this.getTerminologyString(platform)}

STYLE GUIDELINES:
- Style: ${style} (${this.getStyleDescription(style)})
- Tone: ${tone} (${this.getToneDescription(tone)})

PROMPT GENERATION RULES:
1. **MANDATORY**: Every prompt MUST include "${platform}" explicitly
2. Write like a REAL USER, not a tester or developer
3. Use names from context (e.g., "Sarah" not "userId")
4. Reference previous actions naturally ("the product we just created")
5. Include realistic business scenarios
6. Use platform-specific terminology naturally
7. Make it conversational, like continuing a chat
8. Don't mention technical IDs unless absolutely necessary
9. Focus on business value, not technical operations

EXAMPLES OF GOOD VS BAD PROMPTS:
❌ Bad: "Execute GETMANY operation on products"
✅ Good: "Show me all the products in my ${platform} catalog"

❌ Bad: "Create a user record with userId and email parameters"
✅ Good: "Add Sarah Johnson from Marketing to my ${platform} team with email sarah@company.com"

❌ Bad: "Update record ID 12345 with new data"
✅ Good: "Update Sarah's job title to Senior Marketing Manager in ${platform}"

❌ Bad: "Show me my API token details"
✅ Good: "Show me my ${platform} API token details"

❌ Bad: "Send an email to john@example.com"
✅ Good: "Send an email to john@example.com using ${platform}"`;
  }

  private buildUserPrompt(
    action: ModelDefinition,
    context: PromptGenerationContext
  ): string {
    const dependencyInfo = this.buildDependencyInfo(context);
    const conversationFlow = this.buildConversationFlow(context);
    
    return `Generate a natural user prompt for this action:

ACTION TO PROMPT FOR:
- Title: ${action.title}
- Type: ${action.actionName}
- Platform: ${action.connectionPlatform}
- Model: ${action.modelName}

${dependencyInfo}

${conversationFlow}

CONVERSATION CONTEXT:
${context.conversationHistory.conversationFlow}

REQUIREMENTS:
- Use the available context naturally
- Don't ask the user for data that's already available
- Make it sound like a real user request
- Include realistic business names and scenarios
- Reference previous actions if relevant
- Use conversational language

Generate a prompt that a real ${context.platformContext.useCase} user would type.`;
  }

  private buildContextSection(context: PromptGenerationContext): string {
    let section = "";
    
    if (context.executionContext.availableIds && context.executionContext.availableIds.size > 0) {
      section += "CRITICAL: Use these exact values in your prompts - DO NOT ask user for them:\n";
      for (const [key, values] of context.executionContext.availableIds.entries()) {
        const idList = Array.isArray(values) ? values : [values];
        section += `- ${key}: "${idList[0]}" (MUST include this in prompts naturally)\n`;
      }
    }

    if (context.executionContext.availableNames && context.executionContext.availableNames.size > 0) {
      section += "\nAVAILABLE NAMES (weave these into prompts naturally):\n";
      for (const [key, name] of context.executionContext.availableNames.entries()) {
        section += `- ${key}: "${name}" (use this human-readable name)\n`;
      }
    }

    if (context.conversationHistory.previousPrompts.length > 0) {
      section += "\nRECENT USER ACTIONS:\n";
      const recentPrompts = context.conversationHistory.previousPrompts.slice(-3);
      recentPrompts.forEach((prompt, index) => {
        section += `${index + 1}. "${prompt}"\n`;
      });
    }

    return section;
  }

  private buildDependencyInfo(context: PromptGenerationContext): string {
    const deps = context.dependencies;
    let info = "";

    if (deps.requiredIds.length > 0) {
      info += "DEPENDENCIES:\n";
      deps.requiredIds.forEach(reqId => {
        if (context.executionContext.availableIds?.has(reqId)) {
          const value = context.executionContext.availableIds.get(reqId)![0];
          info += `- Needs ${reqId}: ✅ Available as "${value}"\n`;
        } else {
          info += `- Needs ${reqId}: ❌ Missing (may need to create first)\n`;
        }
      });
    }

    if (deps.completedDependencies.size > 0) {
      info += "\nCOMPLETED PREREQUISITES:\n";
      for (const depId of deps.completedDependencies) {
        info += `- ✅ ${depId}\n`;
      }
    }

    return info;
  }

  private buildConversationFlow(context: PromptGenerationContext): string {
    const history = context.conversationHistory;
    if (history.previousPrompts.length === 0) {
      return "CONVERSATION FLOW: This is the first action in the sequence.";
    }

    return `CONVERSATION FLOW: 
Previous actions: ${history.previousPrompts.length}
Last prompt: "${history.previousPrompts[history.previousPrompts.length - 1]}"
Flow: ${history.conversationFlow}`;
  }

  private generateFallbackPrompt(
    action: ModelDefinition,
    context: PromptGenerationContext
  ): LLMPromptGenerationResponse {
    const actionName = action.actionName.toLowerCase();
    const modelName = action.modelName.toLowerCase();
    const platform = context.platformContext.platform;
    
    let prompt = "";
    
    if (actionName.includes('create')) {
      prompt = `Create a new ${modelName} in ${platform}`;
    } else if (actionName.includes('list') || actionName.includes('get')) {
      prompt = `Show me my ${modelName}s in ${platform}`;
    } else if (actionName.includes('update')) {
      prompt = `Update the ${modelName} in ${platform}`;
    } else if (actionName.includes('delete')) {
      prompt = `Delete the ${modelName} in ${platform}`;
    } else {
      prompt = `Help me with ${action.title.toLowerCase()} in ${platform}`;
    }

    if (context.executionContext.availableNames?.size > 0) {
      const firstName = Array.from(context.executionContext.availableNames.values())[0];
      prompt += ` for ${firstName}`;
    }

    return {
      prompt,
      confidence: 0.5,
      reasoning: "Fallback prompt generated due to LLM failure - includes platform name for correct platform selection",
      alternativePrompts: [prompt],
      contextUsed: [],
      suggestedTestData: {}
    };
  }

  private getStyleDescription(style: string): string {
    const descriptions = {
      conversational: "Natural, flowing dialogue",
      business: "Professional but approachable",
      technical: "Precise and specific",
      casual: "Relaxed and informal"
    };
    return descriptions[style as keyof typeof descriptions] || "conversational";
  }

  private getToneDescription(tone: string): string {
    const descriptions = {
      friendly: "Warm and personable",
      professional: "Businesslike and formal",
      direct: "Straight to the point",
      enthusiastic: "Energetic and positive"
    };
    return descriptions[tone as keyof typeof descriptions] || "friendly";
  }

  private initializePlatformTerminology(): void {
    this.platformTerminology.set('hubspot', new Map([
      ['contact', 'contact'],
      ['deal', 'deal'],
      ['company', 'company'],
      ['ticket', 'support ticket'],
      ['task', 'task'],
      ['note', 'note'],
      ['email', 'email'],
      ['meeting', 'meeting']
    ]));

    this.platformTerminology.set('linear', new Map([
      ['issue', 'issue'],
      ['project', 'project'],
      ['team', 'team'],
      ['cycle', 'cycle'],
      ['comment', 'comment'],
      ['label', 'label']
    ]));

    this.platformTerminology.set('attio', new Map([
      ['person', 'person'],
      ['company', 'company'],
      ['deal', 'deal'],
      ['note', 'note'],
      ['task', 'task'],
      ['list', 'list'],
      ['workspace', 'workspace']
    ]));

    this.platformTerminology.set('ecommerce', new Map([
      ['product', 'product'],
      ['cart', 'shopping cart'],
      ['order', 'order'],
      ['customer', 'customer'],
      ['inventory', 'inventory'],
      ['payment', 'payment']
    ]));
  }

  private getTerminologyString(platform: string): string {
    const terminology = this.platformTerminology.get(platform.toLowerCase()) || new Map();
    return Array.from(terminology.entries())
      .map(([key, value]) => `${key} → ${value}`)
      .join(', ');
  }

  recordPromptSuccess(
    prompt: string,
    action: ModelDefinition,
    context: PromptGenerationContext,
    executionTime: number
  ): void {
    this.learningData.push({
      prompt,
      action,
      context,
      success: true,
      executionTime,
      timestamp: Date.now()
    });
    
    this.updatePromptPatterns(prompt, action, true);
  }

  recordPromptFailure(
    prompt: string,
    action: ModelDefinition,
    context: PromptGenerationContext,
    error: string,
    agentResponse?: string
  ): void {
    this.learningData.push({
      prompt,
      action,
      context,
      success: false,
      error,
      agentResponse,
      executionTime: 0,
      timestamp: Date.now()
    });
    
    this.updatePromptPatterns(prompt, action, false);
  }

  private updatePromptPatterns(
    prompt: string,
    action: ModelDefinition,
    success: boolean
  ): void {
    const words = prompt.toLowerCase().split(/\s+/);
    const pattern = words.slice(0, 3).join(' '); 
    
    if (!this.promptPatterns.has(pattern)) {
      this.promptPatterns.set(pattern, {
        pattern,
        successRate: success ? 1 : 0,
        platforms: [action.connectionPlatform],
        actionTypes: [action.actionName],
        contextRequirements: [],
        examples: [prompt]
      });
    } else {
      const existing = this.promptPatterns.get(pattern)!;
      const totalAttempts = existing.examples.length;
      const successCount = Math.round(existing.successRate * totalAttempts) + (success ? 1 : 0);
      
      existing.successRate = successCount / (totalAttempts + 1);
      existing.examples.push(prompt);
      
      if (!existing.platforms.includes(action.connectionPlatform)) {
        existing.platforms.push(action.connectionPlatform);
      }
      if (!existing.actionTypes.includes(action.actionName)) {
        existing.actionTypes.push(action.actionName);
      }
    }
  }

  getSuccessfulPatterns(): PromptPattern[] {
    return Array.from(this.promptPatterns.values())
      .filter(pattern => pattern.successRate > 0.7)
      .sort((a, b) => b.successRate - a.successRate);
  }

  getFailureAnalysis(): { commonFailures: string[], suggestions: string[] } {
    const failures = this.learningData.filter(d => !d.success);
    const commonFailures = failures
      .map(f => f.error || 'Unknown error')
      .reduce((acc, error) => {
        acc[error] = (acc[error] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    return {
      commonFailures: Object.entries(commonFailures)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([error, count]) => `${error} (${count} times)`),
      suggestions: [
        "Use more specific context references",
        "Include realistic business names",
        "Reference previous actions naturally",
        "Use platform-specific terminology"
      ]
    };
  }

  recordPromptResult(actionId: string, prompt: string, success: boolean): void {
    const history = this.promptHistory.get(actionId) || [];
    history.push({ prompt, success });
    this.promptHistory.set(actionId, history);
  }

  recordLLMPromptResult(
    action: ModelDefinition,
    prompt: string,
    success: boolean,
    error?: string,
    agentResponse?: string,
    context?: ExecutionContext
  ): void {
    this.recordPromptResult(action._id, prompt, success);
    
    if (context) {
      const promptContext: PromptGenerationContext = {
        executionContext: context,
        dependencies: {
          graph: null,
          currentAction: action,
          completedDependencies: new Set(),
          availableResources: new Map(),
          requiredIds: [],
          providedIds: []
        },
        conversationHistory: {
          previousPrompts: [],
          previousResponses: [],
          extractedData: [],
          conversationFlow: ""
        },
        platformContext: {
          platform: action.connectionPlatform,
          terminology: new Map(),
          useCase: "unknown",
          scenario: "unknown",
          businessContext: ""
        },
        metadata: {
          attemptNumber: 1,
          isRetry: false,
          totalActionsInSequence: 1,
          currentActionIndex: 0
        }
      };

      if (success) {
        this.recordPromptSuccess(prompt, action, promptContext, 0);
      } else {
        this.recordPromptFailure(prompt, action, promptContext, error || 'Unknown error', agentResponse);
      }
    }
  }
  getLLMPromptInsights(): { successfulPatterns: any[], failureAnalysis: any } {
    return {
      successfulPatterns: this.getSuccessfulPatterns(),
      failureAnalysis: this.getFailureAnalysis()
    };
  }
  resetForNewPlatform(): void {
    this.enhancedContextManager.reset();
  }
}
