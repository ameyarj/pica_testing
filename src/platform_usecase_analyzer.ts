import { generateObject } from "ai";
import { z } from 'zod';
import { ModelDefinition } from './interfaces/interface';
import { PlatformProfile, UseCase} from './interfaces/interface';
import { initializeModel } from './utils/modelInitializer';
import { trackLLMCall } from './utils/tokenTrackerUtils';
import chalk from 'chalk';

const PlatformAnalysisSchema = z.object({
  platform: z.string(),
  primaryUseCase: z.object({
    name: z.string(),
    description: z.string(),
    scenarios: z.array(z.object({
      name: z.string(),
      description: z.string(),
      steps: z.array(z.object({
        actionType: z.string(),
        description: z.string(),
        examplePrompt: z.string(),
        requiredContext: z.array(z.string()),
        providedContext: z.array(z.string())
      })),
      examplePrompts: z.array(z.string()),
      dependencies: z.array(z.string())
    })),
    terminology: z.record(z.string()),
    commonFlows: z.array(z.string())
  }),
  supportedUseCases: z.array(z.object({
    name: z.string(),
    description: z.string(),
    scenarios: z.array(z.object({
      name: z.string(),
      description: z.string(),
      steps: z.array(z.object({
        actionType: z.string(),
        description: z.string(),
        examplePrompt: z.string(),
        requiredContext: z.array(z.string()),
        providedContext: z.array(z.string())
      })),
      examplePrompts: z.array(z.string()),
      dependencies: z.array(z.string())
    })),
    terminology: z.record(z.string()),
    commonFlows: z.array(z.string())
  })),
  terminology: z.record(z.string()),
  businessContext: z.string(),
  typicalWorkflows: z.array(z.string())
});

export class PlatformUseCaseAnalyzer {
  private llmModel: any;
  private platformProfiles: Map<string, PlatformProfile> = new Map();

  constructor(private useClaudeForAnalysis: boolean = true) {
    this.llmModel = initializeModel(useClaudeForAnalysis, 'platform-usecase-analyzer');
  }

  async analyzePlatform(
    platform: string,
    actions: ModelDefinition[]
  ): Promise<PlatformProfile> {
    console.log(chalk.blue(`   🔍 Analyzing platform use cases for: ${platform}`));

    if (this.platformProfiles.has(platform)) {
      console.log(chalk.green(`   ✅ Using cached platform profile for ${platform}`));
      return this.platformProfiles.get(platform)!;
    }

    const systemPrompt = this.buildAnalysisSystemPrompt();
    const userPrompt = this.buildAnalysisUserPrompt(platform, actions);

    try {
      const analysisResult = await trackLLMCall(
        this.useClaudeForAnalysis ? 'claude-sonnet-4-20250514' : 'gpt-4.1',
        systemPrompt,
        userPrompt,
        'platform-usecase-analyzer',
        'analyze-platform',
        async () => {
          const result = await generateObject({
            model: this.llmModel,
            schema: PlatformAnalysisSchema,
            system: systemPrompt,
            prompt: userPrompt,
            temperature: 0.3, 
          });
          return { result: result.object, outputText: JSON.stringify(result.object) };
        }
      );

      const profile: PlatformProfile = {
        platform: analysisResult.platform,
        primaryUseCase: {
          ...analysisResult.primaryUseCase,
          terminology: new Map(Object.entries(analysisResult.primaryUseCase.terminology))
        },
        supportedUseCases: analysisResult.supportedUseCases.map(uc => ({
          ...uc,
          terminology: new Map(Object.entries(uc.terminology))
        })),
        terminology: new Map(Object.entries(analysisResult.terminology)),
        businessContext: analysisResult.businessContext,
        typicalWorkflows: analysisResult.typicalWorkflows
      };

      this.platformProfiles.set(platform, profile);
      
      console.log(chalk.green(`   ✅ Platform analysis complete for ${platform}`));
      console.log(chalk.cyan(`   📋 Primary use case: ${profile.primaryUseCase.name}`));
      console.log(chalk.cyan(`   🔧 ${profile.supportedUseCases.length} additional use cases identified`));

      return profile;

    } catch (error) {
      console.error(chalk.red(`   ❌ Error analyzing platform: ${error}`));
      return this.generateFallbackProfile(platform, actions);
    }
  }

  private buildAnalysisSystemPrompt(): string {
    return `You are an expert business analyst specializing in software platforms and their use cases. 

Your task is to analyze a platform based on its available actions and determine:
1. What the platform is primarily used for (CRM, Project Management, E-commerce, etc.)
2. Common business scenarios and workflows
3. Platform-specific terminology that users would naturally use
4. Realistic conversation flows

ANALYSIS PRINCIPLES:
- Focus on business value, not technical implementation
- Think like an end user, not a developer
- Identify realistic workflows that businesses actually use
- Use natural language that real users would employ
- Consider dependencies between actions (what needs to happen first)

TERMINOLOGY GUIDELINES:
- Map technical terms to user-friendly language
- Use business terminology that practitioners would recognize
- Consider industry-specific jargon where appropriate
- Make it conversational and natural

SCENARIO BUILDING:
- Create realistic business scenarios
- Include proper sequencing (what comes before what)
- Use real-world examples
- Consider various user personas (admin, end-user, manager)`;
  }

  private buildAnalysisUserPrompt(platform: string, actions: ModelDefinition[]): string {
    const actionSummary = this.buildActionSummary(actions);
    const modelTypes = this.extractModelTypes(actions);
    const actionTypes = this.extractActionTypes(actions);

    return `Analyze this platform and its capabilities:

PLATFORM: ${platform}

AVAILABLE ACTIONS (${actions.length} total):
${actionSummary}

MODEL TYPES SUPPORTED:
${modelTypes.join(', ')}

ACTION TYPES AVAILABLE:
${actionTypes.join(', ')}

ANALYSIS REQUIREMENTS:
1. Determine the PRIMARY use case (what is this platform mainly for?)
2. Identify 2-3 additional supported use cases
3. Create realistic business scenarios for each use case
4. Map technical terms to user-friendly language
5. Define typical workflows that businesses would follow
6. Generate example prompts that real users would type

Consider these questions:
- What type of business would use this platform?
- What are the main workflows users would follow?
- How do the actions relate to each other in business processes?
- What terminology would users naturally use?
- What are realistic business scenarios?

Provide a comprehensive analysis that will help generate natural, user-friendly prompts.`;
  }

  private buildActionSummary(actions: ModelDefinition[]): string {
    const grouped = actions.reduce((acc, action) => {
      const key = `${action.modelName} (${action.actionName})`;
      if (!acc[action.modelName]) {
        acc[action.modelName] = [];
      }
      acc[action.modelName].push(action.actionName);
      return acc;
    }, {} as Record<string, string[]>);

    return Object.entries(grouped)
      .map(([model, actions]) => `- ${model}: ${actions.join(', ')}`)
      .join('\n');
  }

  private extractModelTypes(actions: ModelDefinition[]): string[] {
    return [...new Set(actions.map(a => a.modelName))].sort();
  }

  private extractActionTypes(actions: ModelDefinition[]): string[] {
    return [...new Set(actions.map(a => a.actionName))].sort();
  }

  private generateFallbackProfile(platform: string, actions: ModelDefinition[]): PlatformProfile {
    const modelTypes = this.extractModelTypes(actions);
    const hasContacts = modelTypes.some(m => m.toLowerCase().includes('contact') || m.toLowerCase().includes('person'));
    const hasDeals = modelTypes.some(m => m.toLowerCase().includes('deal') || m.toLowerCase().includes('opportunity'));
    const hasProjects = modelTypes.some(m => m.toLowerCase().includes('project') || m.toLowerCase().includes('issue'));
    const hasProducts = modelTypes.some(m => m.toLowerCase().includes('product') || m.toLowerCase().includes('inventory'));

    let primaryUseCase: UseCase;
    let businessContext: string;

    if (hasContacts && hasDeals) {
      primaryUseCase = {
        name: "Customer Relationship Management (CRM)",
        description: "Managing customer relationships and sales processes",
        scenarios: [{
          name: "Lead to Customer Flow",
          description: "Converting leads into customers",
          steps: [],
          examplePrompts: [
            "Add a new contact for Sarah Johnson",
            "Create a deal for Acme Corp worth $50,000",
            "Update the deal stage to 'Proposal Sent'"
          ],
          dependencies: ["contact", "deal"]
        }],
        terminology: new Map([
          ['contact', 'contact'],
          ['person', 'person'],
          ['deal', 'deal'],
          ['company', 'company']
        ]),
        commonFlows: ["Lead generation", "Deal management", "Customer onboarding"]
      };
      businessContext = "Sales and customer relationship management";
    } else if (hasProjects) {
      primaryUseCase = {
        name: "Project Management",
        description: "Managing projects, tasks, and team collaboration",
        scenarios: [{
          name: "Project Setup and Management",
          description: "Creating and managing projects",
          steps: [],
          examplePrompts: [
            "Create a new project for Q1 2024 goals",
            "Add a task to fix the login bug",
            "Assign this task to Sarah"
          ],
          dependencies: ["project", "task"]
        }],
        terminology: new Map([
          ['project', 'project'],
          ['issue', 'task'],
          ['task', 'task'],
          ['team', 'team']
        ]),
        commonFlows: ["Project creation", "Task management", "Team collaboration"]
      };
      businessContext = "Project and task management";
    } else if (hasProducts) {
      primaryUseCase = {
        name: "E-commerce",
        description: "Managing products, orders, and customer transactions",
        scenarios: [{
          name: "Product to Order Flow",
          description: "Managing product catalog and orders",
          steps: [],
          examplePrompts: [
            "Add a new product called Wireless Headphones",
            "Create an order for customer John Smith",
            "Update inventory for product ABC123"
          ],
          dependencies: ["product", "order"]
        }],
        terminology: new Map([
          ['product', 'product'],
          ['order', 'order'],
          ['customer', 'customer'],
          ['inventory', 'inventory']
        ]),
        commonFlows: ["Product management", "Order processing", "Inventory tracking"]
      };
      businessContext = "E-commerce and retail";
    } else {
      primaryUseCase = {
        name: "Data Management",
        description: "General data and record management",
        scenarios: [{
          name: "Record Management",
          description: "Creating and managing records",
          steps: [],
          examplePrompts: [
            "Create a new record",
            "Show me all records",
            "Update the record"
          ],
          dependencies: []
        }],
        terminology: new Map([
          ['record', 'record'],
          ['data', 'data']
        ]),
        commonFlows: ["Data entry", "Record management", "Data retrieval"]
      };
      businessContext = "General data management";
    }

    return {
      platform,
      primaryUseCase,
      supportedUseCases: [],
      terminology: primaryUseCase.terminology,
      businessContext,
      typicalWorkflows: primaryUseCase.commonFlows
    };
  }

  generateBusinessContext(platform: string): string {
    const profile = this.platformProfiles.get(platform);
    if (!profile) {
      return `Working with ${platform} platform`;
    }
    
    return `Using ${platform} for ${profile.businessContext}. Focus on ${profile.primaryUseCase.description.toLowerCase()}.`;
  }

  getUseCaseForAction(platform: string, action: ModelDefinition): string {
    const profile = this.platformProfiles.get(platform);
    if (!profile) {
      return "data management";
    }

    const allScenarios = [
      ...profile.primaryUseCase.scenarios,
      ...profile.supportedUseCases.flatMap(uc => uc.scenarios)
    ];

    const matchingScenario = allScenarios.find(scenario =>
      scenario.steps.some(step => 
        step.actionType.toLowerCase().includes(action.actionName.toLowerCase()) ||
        action.modelName.toLowerCase().includes(scenario.name.toLowerCase())
      )
    );

    return matchingScenario ? matchingScenario.name : profile.primaryUseCase.name;
  }

  getTerminologyMap(platform: string): Map<string, string> {
    const profile = this.platformProfiles.get(platform);
    return profile?.terminology || new Map();
  }

  getTypicalWorkflows(platform: string): string[] {
    const profile = this.platformProfiles.get(platform);
    return profile?.typicalWorkflows || [];
  }

  getPlatformSummary(platform: string): string {
    const profile = this.platformProfiles.get(platform);
    if (!profile) {
      return `No profile available for ${platform}`;
    }

    return `${platform}: ${profile.primaryUseCase.name} - ${profile.businessContext}`;
  }

  getAllPlatformProfiles(): Map<string, PlatformProfile> {
    return new Map(this.platformProfiles);
  }
}
