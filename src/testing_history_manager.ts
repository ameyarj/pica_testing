import fs from 'fs';
import path from 'path';
import { BatchInfo } from './batch_manager';
import chalk from 'chalk';

export interface TestingSession {
  sessionId: string;
  date: string;
  batches: BatchInfo[];
  totalDuration: string;
  platform: string;
}

export interface TestingHistory {
  platform: string;
  sessions: TestingSession[];
  totalActionsCompleted: number;
  lastUpdated: string;
}


export class TestingHistoryManager {
  private historyDir: string;

  constructor() {
    this.historyDir = path.join(process.cwd(), 'logs', 'history');
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  getHistory(platform: string): TestingHistory {
    const historyFile = this.getHistoryFilename(platform);
    
    if (!fs.existsSync(historyFile)) {
      return {
        platform,
        sessions: [],
        totalActionsCompleted: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    try {
      const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      return data;
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to load history: ${error}`));
      return {
        platform,
        sessions: [],
        totalActionsCompleted: 0,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  addBatch(platform: string, batchInfo: BatchInfo): void {
    const history = this.getHistory(platform);
    
    const today = new Date().toISOString().split('T')[0];
    let currentSession = history.sessions.find(s => s.date === today);
    
    if (!currentSession) {
      currentSession = {
        sessionId: `${platform}_${today}`,
        date: today,
        batches: [],
        totalDuration: '0h 0m',
        platform
      };
      history.sessions.push(currentSession);
    }

    currentSession.batches.push(batchInfo);
    
    history.totalActionsCompleted += batchInfo.actionCount;
    history.lastUpdated = new Date().toISOString();
    
    currentSession.totalDuration = this.calculateSessionDuration(currentSession.batches);

    this.saveHistory(history);
  }

  getLatestBatch(platform: string): number {
    const history = this.getHistory(platform);
    let maxBatch = 0;
    
    for (const session of history.sessions) {
      for (const batch of session.batches) {
        maxBatch = Math.max(maxBatch, batch.batchNumber);
      }
    }
    
    return maxBatch;
  }

  displayHistory(platform: string): void {
    const history = this.getHistory(platform);
    
    if (history.sessions.length === 0) {
      console.log(chalk.gray(`   No testing history found for ${platform}`));
      return;
    }

    console.log(chalk.bold.cyan(`\n📚 Testing History for ${platform}:`));
    console.log(chalk.cyan(`Total actions completed: ${history.totalActionsCompleted}`));
    console.log(chalk.cyan(`Last updated: ${new Date(history.lastUpdated).toLocaleDateString()}`));

    for (const session of history.sessions.slice(-3)) { // Show last 3 sessions
      console.log(chalk.yellow(`\n📅 ${session.date} (${session.totalDuration}):`));
      for (const batch of session.batches) {
        const successRate = batch.actionCount > 0 ? Math.round((batch.successCount / batch.actionCount) * 100) : 0;
        console.log(`   Batch ${batch.batchNumber}: ${batch.range} - ${batch.successCount}/${batch.actionCount} (${successRate}%) - ${batch.duration}`);
      }
    }

    if (history.sessions.length > 3) {
      console.log(chalk.gray(`   ... and ${history.sessions.length - 3} more sessions`));
    }
  }

  getLastActionIndex(platform: string): number {
    const history = this.getHistory(platform);
    let maxIndex = 0;
    
    for (const session of history.sessions) {
      for (const batch of session.batches) {
        const rangeMatch = batch.range.match(/(\d+)-(\d+)/);
        if (rangeMatch) {
          maxIndex = Math.max(maxIndex, parseInt(rangeMatch[2]));
        }
      }
    }
    
    return maxIndex;
  }

  private calculateSessionDuration(batches: BatchInfo[]): string {
    let totalMinutes = 0;
    
    for (const batch of batches) {
      const match = batch.duration.match(/(\d+)h\s*(\d+)m/);
      if (match) {
        totalMinutes += parseInt(match[1]) * 60 + parseInt(match[2]);
      }
    }
    
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }

  private saveHistory(history: TestingHistory): void {
    const historyFile = this.getHistoryFilename(history.platform);
    
    try {
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
      console.log(chalk.green(`   ✅ Saved testing history: ${historyFile}`));
    } catch (error) {
      console.error(chalk.red(`   ❌ Failed to save history: ${error}`));
      throw error; 
    }
  }

  private getHistoryFilename(platform: string): string {
    const safePlatformName = platform.replace(/[^a-zA-Z0-9\s-]/g, '_');
    return path.join(this.historyDir, `${safePlatformName}_history.json`);
  }

  saveInterruptedBatch(executionState: any): void {
    if (!executionState) return;
    
    const history = this.getHistory(executionState.platform);
    const today = new Date().toISOString().split('T')[0];
    
    let currentSession = history.sessions.find(s => s.date === today);
    if (!currentSession) {
      currentSession = {
        sessionId: `${executionState.platform}_${today}`,
        date: today,
        batches: [],
        totalDuration: '0h 0m',
        platform: executionState.platform
      };
      history.sessions.push(currentSession);
    }

    const batchInfo: BatchInfo = {
      batchNumber: executionState.batchNumber,
      range: executionState.actionRange,
      actionCount: executionState.executedActions.length,
      successCount: executionState.executedActions.filter((a: any) => a.success).length,
      duration: 'interrupted',
      timestamp: new Date().toISOString(),
      status: 'interrupted',
      interruptedAt: executionState.currentActionIndex
    };

    const existingBatchIndex = currentSession.batches.findIndex(b => b.batchNumber === executionState.batchNumber);
    if (existingBatchIndex >= 0) {
      const previousActionCount = currentSession.batches[existingBatchIndex].actionCount;
      currentSession.batches[existingBatchIndex] = batchInfo;
      
      history.totalActionsCompleted += (batchInfo.actionCount - previousActionCount);
    } else {
      currentSession.batches.push(batchInfo);
      
      history.totalActionsCompleted += batchInfo.actionCount;
    }
    
    history.lastUpdated = new Date().toISOString();
    
    this.saveHistory(history);
    console.log(chalk.yellow(`   ⚠️ Saved interrupted batch ${executionState.batchNumber} to history (${batchInfo.actionCount} actions completed)`));
  }

  hasInterruptedBatch(platform: string): {canResume: boolean, batchInfo?: any} {
    const history = this.getHistory(platform);
    
    for (const session of history.sessions.reverse()) {
      for (const batch of session.batches.reverse()) {
        if (batch.status === 'interrupted') {
          return {
            canResume: true,
            batchInfo: batch
          };
        }
      }
    }
    
    return {canResume: false};
  }

  clearHistory(platform: string): void {
    const historyFile = this.getHistoryFilename(platform);
    if (fs.existsSync(historyFile)) {
      fs.unlinkSync(historyFile);
      console.log(chalk.yellow(`   🗑️ Cleared history for ${platform}`));
    }
  }
}
