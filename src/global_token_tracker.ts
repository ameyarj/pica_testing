import chalk from 'chalk';

interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  component: string;
  timestamp: number;
  operation: string;
}

interface ModelPricing {
  input: number;  
  output: number; 
}

export class GlobalTokenTracker {
  private static instance: GlobalTokenTracker;
  private tokenUsage: TokenUsage[] = [];
  private modelUsageMap: Map<string, { tokens: number; cost: number }> = new Map();
  
  private readonly pricing: Record<string, ModelPricing> = {
    'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4.1': { input: 0.02, output: 0.008 },
  };

  private constructor() {}

  static getInstance(): GlobalTokenTracker {
    if (!GlobalTokenTracker.instance) {
      GlobalTokenTracker.instance = new GlobalTokenTracker();
    }
    return GlobalTokenTracker.instance;
  }

  reset(): void {
    this.tokenUsage = [];
    this.modelUsageMap.clear();
  }

  trackUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    component: string,
    operation: string
  ): void {
    const cost = this.calculateCost(model, inputTokens, outputTokens);
    
    const usage: TokenUsage = {
      model,
      inputTokens,
      outputTokens,
      cost,
      component,
      operation,
      timestamp: Date.now()
    };

    this.tokenUsage.push(usage);

    const current = this.modelUsageMap.get(model) || { tokens: 0, cost: 0 };
    this.modelUsageMap.set(model, {
      tokens: current.tokens + inputTokens + outputTokens,
      cost: current.cost + cost
    });
  }

  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    let normalizedModel = model;
    if (model.includes('claude')) {
      if (model.includes('sonnet')) {
        normalizedModel = 'claude-sonnet-4-20250514';
      }
    } else if (model.includes('gpt-4o')) {
      normalizedModel = 'gpt-4o';
    } else if (model.includes('gpt-4')) {
      normalizedModel = 'gpt-4.1';
    }

    const pricing = this.pricing[normalizedModel] || this.pricing['gpt-4.1'];
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1000;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getTotalCost(): number {
    return this.tokenUsage.reduce((total, usage) => total + usage.cost, 0);
  }

  getModelUsageSummary(): Map<string, { tokens: number; cost: number }> {
    return new Map(this.modelUsageMap);
  }

  getComponentUsageSummary(): Map<string, { tokens: number; cost: number; operations: number }> {
    const componentMap = new Map<string, { tokens: number; cost: number; operations: number }>();
    
    for (const usage of this.tokenUsage) {
      const current = componentMap.get(usage.component) || { tokens: 0, cost: 0, operations: 0 };
      componentMap.set(usage.component, {
        tokens: current.tokens + usage.inputTokens + usage.outputTokens,
        cost: current.cost + usage.cost,
        operations: current.operations + 1
      });
    }
    
    return componentMap;
  }

  getDetailedBreakdown(): {
    byModel: Array<{ model: string; tokens: number; cost: number; percentage: number }>;
    byComponent: Array<{ component: string; tokens: number; cost: number; operations: number }>;
    byOperation: Array<{ operation: string; count: number; cost: number }>;
    timeline: Array<{ time: string; cost: number }>;
  } {
    const totalCost = this.getTotalCost();
    
    const byModel = Array.from(this.modelUsageMap.entries()).map(([model, data]) => ({
      model,
      tokens: data.tokens,
      cost: data.cost,
      percentage: totalCost > 0 ? (data.cost / totalCost) * 100 : 0
    })).sort((a, b) => b.cost - a.cost);

    const byComponent = Array.from(this.getComponentUsageSummary().entries())
      .map(([component, data]) => ({
        component,
        tokens: data.tokens,
        cost: data.cost,
        operations: data.operations
      }))
      .sort((a, b) => b.cost - a.cost);

    const operationMap = new Map<string, { count: number; cost: number }>();
    for (const usage of this.tokenUsage) {
      const current = operationMap.get(usage.operation) || { count: 0, cost: 0 };
      operationMap.set(usage.operation, {
        count: current.count + 1,
        cost: current.cost + usage.cost
      });
    }
    const byOperation = Array.from(operationMap.entries())
      .map(([operation, data]) => ({
        operation,
        count: data.count,
        cost: data.cost
      }))
      .sort((a, b) => b.cost - a.cost);

    const timelineMap = new Map<string, number>();
    for (const usage of this.tokenUsage) {
      const hour = new Date(usage.timestamp).toISOString().substring(0, 13);
      timelineMap.set(hour, (timelineMap.get(hour) || 0) + usage.cost);
    }
    const timeline = Array.from(timelineMap.entries())
      .map(([time, cost]) => ({ time, cost }))
      .sort((a, b) => a.time.localeCompare(b.time));

    return { byModel, byComponent, byOperation, timeline };
  }

  printSummary(): void {
    const totalCost = this.getTotalCost();
    console.log(chalk.bold.cyan('\n💰 Token Usage Summary:'));
    console.log(chalk.bold(`Total Cost: $${totalCost.toFixed(4)}`));
    
    console.log(chalk.cyan('\nBy Model:'));
    for (const [model, data] of this.modelUsageMap.entries()) {
      const percentage = totalCost > 0 ? (data.cost / totalCost) * 100 : 0;
      console.log(`  ${model}: ${data.tokens.toLocaleString()} tokens, $${data.cost.toFixed(4)} (${percentage.toFixed(1)}%)`);
    }

    const componentSummary = this.getComponentUsageSummary();
    console.log(chalk.cyan('\nBy Component:'));
    for (const [component, data] of componentSummary.entries()) {
      console.log(`  ${component}: ${data.operations} operations, $${data.cost.toFixed(4)}`);
    }
  }
}

export const tokenTracker = GlobalTokenTracker.getInstance();
