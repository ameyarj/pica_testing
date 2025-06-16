import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

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
  };
  duration: number;
}

export class ExecutionLogger {
  private logDir: string;
  private currentLogFile: string;
  private sessionId: string;
  private totalCost: number = 0;
  private modelUsage: Map<string, { tokens: number; cost: number }> = new Map();

  constructor() {
    this.sessionId = `session_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.currentLogFile = path.join(this.logDir, `${this.sessionId}.json`);
    this.initializeLogFile();
  }

  private initializeLogFile(): void {
    const header = {
      sessionId: this.sessionId,
      startTime: new Date().toISOString(),
      entries: []
    };
    fs.writeFileSync(this.currentLogFile, JSON.stringify(header, null, 2));
  }

  logExecution(entry: Omit<LogEntry, 'timestamp' | 'sessionId'>): void {
    const fullEntry: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId
    };

    // Update totals
    this.totalCost += entry.tokens.cost;
    const modelKey = entry.tokens.model;
    const current = this.modelUsage.get(modelKey) || { tokens: 0, cost: 0 };
    this.modelUsage.set(modelKey, {
      tokens: current.tokens + entry.tokens.input + entry.tokens.output,
      cost: current.cost + entry.tokens.cost
    });

    // Append to log file
    const logData = JSON.parse(fs.readFileSync(this.currentLogFile, 'utf-8'));
    logData.entries.push(fullEntry);
    fs.writeFileSync(this.currentLogFile, JSON.stringify(logData, null, 2));
  }

  generateSummaryReport(): void {
    const summaryFile = path.join(this.logDir, `${this.sessionId}_summary.md`);
    const logData = JSON.parse(fs.readFileSync(this.currentLogFile, 'utf-8'));
    
    let summary = `# Execution Summary\n\n`;
    summary += `**Session ID:** ${this.sessionId}\n`;
    summary += `**Duration:** ${new Date(logData.entries[logData.entries.length - 1]?.timestamp).getTime() - new Date(logData.startTime).getTime()}ms\n`;
    summary += `**Total Cost:** $${this.totalCost.toFixed(4)}\n\n`;
    
    summary += `## Model Usage\n\n`;
    for (const [model, usage] of this.modelUsage.entries()) {
      summary += `- **${model}**: ${usage.tokens} tokens, $${usage.cost.toFixed(4)}\n`;
    }
    
    summary += `\n## Actions Summary\n\n`;
    const platforms = new Map<string, { success: number; failed: number }>();
    
    for (const entry of logData.entries) {
      const key = entry.platform;
      const current = platforms.get(key) || { success: 0, failed: 0 };
      if (entry.response.success) {
        current.success++;
      } else {
        current.failed++;
      }
      platforms.set(key, current);
    }
    
    for (const [platform, stats] of platforms.entries()) {
      summary += `### ${platform}\n`;
      summary += `- Success: ${stats.success}\n`;
      summary += `- Failed: ${stats.failed}\n`;
      summary += `- Success Rate: ${((stats.success / (stats.success + stats.failed)) * 100).toFixed(1)}%\n\n`;
    }

    fs.writeFileSync(summaryFile, summary);
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  calculateCost(model: 'claude-sonnet-4-20250514' | 'gpt-4.1' | 'gpt-4o', inputTokens: number, outputTokens: number): number {
    const pricing = {
      'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
      'gpt-4.1': { input: 0.01, output: 0.03 },
      'gpt-4o': { input: 0.005, output: 0.015 }
    };
    
    const modelPricing = pricing[model] || pricing['gpt-4.1'];
    return (inputTokens * modelPricing.input + outputTokens * modelPricing.output) / 1000;
  }
}