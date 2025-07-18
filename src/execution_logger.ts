import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { tokenTracker } from './global_token_tracker';

interface LogEntry {
  timestamp: string;
  sessionId: string;
  platform: string;
  model: string;
  action: string;
  actionId: string;
  attempt: number;
  prompt: {
    strategy: string;
    length: number;
    content: string;
    fullContent?: string;  
  };
  response: {
    success: boolean;
    error?: string;
    extractedData?: {
      ids: Record<string, string>;
      names: Record<string, string>;
      emails: string[];
      phones: string[];
      metadata: Record<string, any>;
    };
    agentOutput: string;
    analysisReason?: string;
  };
  tokens: {
    model: string;
    input: number;
    output: number;
    cost: number;
    component?: string;  
  };
  duration: number;
  batchNumber?: number;
  actionRange?: string;
  totalBatches?: number;
}

export class ExecutionLogger {
  private logDir: string;
  private currentLogFile: string;
  private sessionId: string;
  private totalCost: number = 0;
  private modelUsage: Map<string, { tokens: number; cost: number }> = new Map();
  private batchMetadata: { batchNumber?: number; actionRange?: string; totalBatches?: number } = {};

  constructor(platformName?: string) {
    if (!platformName) {
      throw new Error('Platform name is required for ExecutionLogger');
    }
    
    const safePlatformName = platformName.replace(/[^a-zA-Z0-9\s-]/g, '_');
    this.sessionId = safePlatformName;
    
    const isProduction = process.env.NODE_ENV === 'production';
    const isRailway = process.env.RAILWAY_ENVIRONMENT;
    
    if (isProduction && isRailway) {
      this.logDir = path.join(process.cwd(), 'data', 'logs');
    } else if (isProduction) {
      this.logDir = path.join('/data', 'logs');
    } else {
      this.logDir = path.join(process.cwd(), 'logs');
    }
    
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    
    this.currentLogFile = path.join(this.logDir, `${safePlatformName}.json`);
    this.initializeLogFile();
  }

  setBatchMetadata(batchNumber: number, actionRange: string, totalBatches: number): void {
  this.batchMetadata = { batchNumber, actionRange, totalBatches };
}

  private initializeLogFile(): void {
    if (!fs.existsSync(this.currentLogFile)) {
      const header = {
        sessionId: this.sessionId,
        startTime: new Date().toISOString(),
        entries: []
      };
      fs.writeFileSync(this.currentLogFile, JSON.stringify(header, null, 2));
    } else {
      try {
        const logData = JSON.parse(fs.readFileSync(this.currentLogFile, 'utf-8'));
        logData.lastSessionStart = new Date().toISOString();
        fs.writeFileSync(this.currentLogFile, JSON.stringify(logData, null, 2));
        console.log(chalk.blue(`   📄 Appending to existing log file for ${this.sessionId}`));
      } catch (error) {
        console.error(chalk.yellow(`   ⚠️ Could not read existing log file, creating new one`));
        const header = {
          sessionId: this.sessionId,
          startTime: new Date().toISOString(),
          entries: []
        };
        fs.writeFileSync(this.currentLogFile, JSON.stringify(header, null, 2));
      }
    }
  }

  logExecution(entry: Omit<LogEntry, 'timestamp' | 'sessionId'>): void {
    const fullPrompt = entry.prompt.content;    
    const fullEntry: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      batchNumber: this.batchMetadata.batchNumber,
      actionRange: this.batchMetadata.actionRange,
      totalBatches: this.batchMetadata.totalBatches,
      prompt: {
        ...entry.prompt,
        content: fullPrompt,
      }
    };

    this.totalCost += entry.tokens.cost;
    const modelKey = entry.tokens.model;
    const current = this.modelUsage.get(modelKey) || { tokens: 0, cost: 0 };
    this.modelUsage.set(modelKey, {
      tokens: current.tokens + entry.tokens.input + entry.tokens.output,
      cost: current.cost + entry.tokens.cost
    });

    const logData = JSON.parse(fs.readFileSync(this.currentLogFile, 'utf-8'));
    logData.entries.push(fullEntry);
    fs.writeFileSync(this.currentLogFile, JSON.stringify(logData, null, 2));
  }

  generateSummaryReport(): void {
    const summaryFile = path.join(this.logDir, `${this.sessionId}_summary.md`);
    let logData: { entries: LogEntry[], startTime?: string } = { entries: [] };
    let parsingError: string | null = null;

    try {
      if (fs.existsSync(this.currentLogFile)) {
          const fileContent = fs.readFileSync(this.currentLogFile, 'utf-8');
          if (fileContent) {
            logData = JSON.parse(fileContent);
          }
      }
    } catch (error: any) {
      console.error(chalk.yellow('Warning: Could not parse log file, it might be incomplete. Summary will be based on in-memory data.'), error.message);
      parsingError = error.message;
    }
    
    const entries = logData.entries || [];

    const globalBreakdown = tokenTracker.getDetailedBreakdown();
    const globalTotalCost = tokenTracker.getTotalCost();

    const toIST = (dateStr: string): string => {
      const date = new Date(dateStr);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(date.getTime() + istOffset);
      return istTime.toISOString();
    };

    let summary = '# 🚀 Pica Platform Testing Report\n\n';
    summary += '## 📋 Session Information\n\n';
    summary += '| Field | Value |\n';
    summary += '|-------|-------|\n';
    summary += `| **Platform** | ${this.sessionId.split(' - ')[0]} |\n`;
    summary += `| **Session ID** | ${this.sessionId} |\n`;
    summary += `| **Start Time (IST)** | ${logData.startTime ? new Date(toIST(logData.startTime)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A'} |\n`;
    summary += `| **End Time (IST)** | ${new Date(toIST(new Date().toISOString())).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} |\n`;
    summary += `| **Duration** | ${this.calculateDuration(logData.startTime)} |\n`;
    
    if (parsingError) {
      summary += '\n> ⚠️ **Warning:** The JSON log file was corrupted and could not be fully read. The summary may be incomplete.\n';
    }

    summary += '\n## 💰 Cost & Token Usage Analysis\n\n';
    summary += '### Overall Cost\n';
    summary += `- **Total Cost (Global Tracker):** $${globalTotalCost.toFixed(4)}\n`;
    summary += `- **Total Cost (Log-based):** $${this.totalCost.toFixed(4)}\n\n`;
    
    if (globalBreakdown.byModel.length > 0) {
      summary += '### Model Usage Breakdown\n\n';
      summary += '| Model | Tokens | Cost | Usage % |\n';
      summary += '|-------|--------|------|--------|\n';
      for (const model of globalBreakdown.byModel) {
        summary += `| **${model.model}** | ${model.tokens.toLocaleString()} | $${model.cost.toFixed(4)} | ${model.percentage.toFixed(1)}% |\n`;
      }
      summary += '\n';
    }

    if (globalBreakdown.byComponent.length > 0) {
      summary += '### Component Usage Breakdown\n\n';
      summary += '| Component | Operations | Tokens | Cost |\n';
      summary += '|-----------|------------|--------|------|\n';
      for (const comp of globalBreakdown.byComponent) {
        summary += `| **${comp.component}** | ${comp.operations} | ${comp.tokens.toLocaleString()} | $${comp.cost.toFixed(4)} |\n`;
      }
      summary += '\n';
    }
    summary += '## 📊 Actions Execution Summary\n\n';
    
    const actionDetailsMap = new Map<string, {
      title: string;
      modelName: string;
      success: boolean;
      attempts: number;
      finalStrategy?: string;
      error?: string;
      passNumber: number;
    }>();

    for (const entry of entries) {
      const key = `${entry.actionId}`;
      const existing = actionDetailsMap.get(key);
      
      actionDetailsMap.set(key, {
        title: entry.action,
        modelName: entry.model,
        success: entry.response.success,
        attempts: existing ? existing.attempts + 1 : 1,
        finalStrategy: entry.prompt.strategy,
        error: entry.response.error,
        passNumber: existing && !existing.success && entry.response.success ? 2 : 1
      });
    }

    const successfulActions = Array.from(actionDetailsMap.values()).filter(a => a.success);
    const failedActions = Array.from(actionDetailsMap.values()).filter(a => !a.success);
    const totalActions = actionDetailsMap.size;
    const successRate = totalActions > 0 ? (successfulActions.length / totalActions * 100).toFixed(1) : '0';

    summary += '### Overall Results\n\n';
    summary += '| Metric | Value |\n';
    summary += '|--------|-------|\n';
    summary += `| **Total Actions** | ${totalActions} |\n`;
    summary += `| **Successful** | ${successfulActions.length} ✅ |\n`;
    summary += `| **Failed** | ${failedActions.length} ❌ |\n`;
    summary += `| **Success Rate** | ${successRate}% |\n\n`;

    const actionPassMap = new Map<string, { pass1Success: boolean; pass2Success: boolean; attempts: number }>();
    
    for (const entry of entries) {
      const key = `${entry.actionId}`;
      const existing = actionPassMap.get(key) || { pass1Success: false, pass2Success: false, attempts: 0 };
      
      existing.attempts++;
      if (existing.attempts === 1 && entry.response.success) {
        existing.pass1Success = true;
      } else if (existing.attempts > 1 && entry.response.success && !existing.pass1Success) {
        existing.pass2Success = true;
      }
      
      actionPassMap.set(key, existing);
    }
    
    const pass1Success = Array.from(actionPassMap.values()).filter(a => a.pass1Success).length;
    const pass2Success = Array.from(actionPassMap.values()).filter(a => a.pass2Success).length;
    
    summary += '### Pass-by-Pass Breakdown\n\n';
    summary += `- **Pass 1:** ${pass1Success} successes on first attempt\n`;
    summary += `- **Pass 2:** ${pass2Success} successes with enhanced context\n\n`;

    const strategyMap = new Map<string, { total: number; success: number }>();
    for (const entry of entries) {
      let strategy = entry.prompt.strategy;
      if (strategy === 'conversation') {
        strategy = 'conversational';
      }
      
      const current = strategyMap.get(strategy) || { total: 0, success: 0 };
      current.total++;
      if (entry.response.success) current.success++;
      strategyMap.set(strategy, current);
    }

    if (strategyMap.size > 0) {
      summary += '### Strategy Effectiveness\n\n';
      summary += '| Strategy | Attempts | Successes | Success Rate |\n';
      summary += '|----------|----------|-----------|-------------|\n';
      for (const [strategy, data] of strategyMap.entries()) {
        const rate = data.total > 0 ? (data.success / data.total * 100).toFixed(1) : '0';
        summary += `| **${strategy}** | ${data.total} | ${data.success} | ${rate}% |\n`;
      }
      summary += '\n';
    }

    if (failedActions.length > 0) {
      summary += '### Failed Actions Details\n\n';
      for (const action of failedActions) {
        summary += `#### ❌ ${action.title}\n`;
        summary += `- **Model:** ${action.modelName}\n`;
        summary += `- **Attempts:** ${action.attempts}\n`;
        summary += `- **Error:** ${action.error || 'Unknown error'}\n\n`;
      }
    }

    summary += '## 💡 Insights & Recommendations\n\n';
    
    const sortedStrategies = Array.from(strategyMap.entries())
      .sort((a, b) => b[1].success - a[1].success)
      .slice(0, 3);
    
    if (sortedStrategies.length > 0) {
      summary += '### Most Effective Prompt Strategies\n\n';
      for (const [strategy, data] of sortedStrategies) {
        summary += `- **${strategy}:** ${data.success} successes\n`;
      }
      summary += '\n';
    }

    summary += '---\n\n';
    summary += '*Generated by Pica Platform Testing Suite*\n';
    summary += `*Report generated at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}*\n`;

    fs.writeFileSync(summaryFile, summary);
    console.log(chalk.bold.green(`\n📊 Summary report generated: ${summaryFile}`));
  }

  private calculateDuration(startTime?: string): string {
    if (!startTime) return 'N/A';
    const start = new Date(startTime);
    const end = new Date();
    const diff = end.getTime() - start.getTime();
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  calculateCost(model: 'claude-sonnet-4-20250514' | 'gpt-4.1' | 'gpt-4o', inputTokens: number, outputTokens: number): number {
    const pricing = {
      'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
      'gpt-4.1': { input: 0.002, output: 0.008 },  
      'gpt-4o': { input: 0.005, output: 0.015 },
    };
    
    const modelPricing = pricing[model] || pricing['gpt-4.1'];
    return (inputTokens * modelPricing.input + outputTokens * modelPricing.output) / 1000;
  }
}
