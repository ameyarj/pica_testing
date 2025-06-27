import { z } from 'zod';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  patterns?: ResponsePattern[];
}

export interface ConversationState {
  turns: ConversationTurn[];
  status: 'initial' | 'waiting_approval' | 'executing' | 'completed' | 'failed';
  taskCompleted: boolean;
  turnCount: number;
  lastError?: string;
  extractedData?: any;
}

export interface ResponsePattern {
  type: 'permission_request' | 'data_needed' | 'suggestion' | 'partial_success' | 'error' | 'completed';
  confidence: number;
  details: string;
  suggestedResponse?: string;
}

export class ConversationHandler {
  private readonly MAX_TURNS = 3; 
  private readonly PATTERN_MATCHERS = {
    permission_request: [
      /would you like me to/i,
      /can i (?:proceed|try|attempt)/i,
      /should i (?:go ahead|continue)/i,
      /do you want me to/i,
      /shall i/i,
      /may i/i
    ],
    data_needed: [
      /(?:need|require|missing) (?:the |a |an )?(\w+)/i,
      /please (?:provide|specify) (?:the |a |an )?(\w+)/i,
      /what (?:is|are) (?:the |your )?(\w+)/i,
      /(?:don't have|lacking|without) (?:the |a |an )?(\w+)/i,
      /to proceed.*need/i
    ],
    suggestion: [
      /i (?:can|could) (?:try|attempt|help)/i,
      /alternatively/i,
      /instead/i,
      /another option/i,
      /i'll (?:try|attempt)/i,
      /let me/i
    ],
    partial_success: [
      /successfully (?:created|updated|retrieved|deleted)/i,
      /now (?:i need|let's|we can)/i,
      /completed.*but/i,
      /done.*however/i,
      /finished.*next/i
    ],
    error: [
      /(?:error|failed|failure|unable|couldn't|can't)/i,
      /(?:denied|forbidden|unauthorized|403|404|500)/i,
      /not (?:found|exist|available)/i,
      /invalid|malformed|incorrect/i
    ],
    completed: [
      /successfully (?:created|updated|retrieved|deleted|listed|fetched)/i,
      /(?:created|updated|modified|customized).*(?:project|resource|item).*with/i,
      /"id"\s*:\s*"[a-f0-9-]{36}"/i,
      /(?:project|resource|item).*(?:has been|was).*(?:created|updated|modified)/i,
      /"success"\s*:\s*true/i,
      /(?:Complete|Finished|Done).*(?:successfully|with success)/i,
      /Here'?s? (?:the|your|a)? (?:list|summary|details|information)/i,
      /✅.*(?:SUCCESS|Success|successfully)/i,
      /workflow.*successfully completed/i,
      /all (?:projects|items|resources).*(?:retrieved|listed|fetched)/i,
      /I've (?:successfully|just).*(?:created|updated|modified|customized|retrieved|listed)/i
    ]
  };

  detectResponsePatterns(response: string): ResponsePattern[] {
    const patterns: ResponsePattern[] = [];
    const lowerResponse = response.toLowerCase();

    for (const pattern of this.PATTERN_MATCHERS.completed) {
      if (pattern.test(response)) {
        patterns.push({
          type: 'completed',
          confidence: 0.95,
          details: 'Task completed with evidence',
          suggestedResponse: undefined
        });
        return patterns;
      }
    }

    const hasQuestionMark = response.trim().endsWith('?');
    
    const isProgressUpdate = /(?:i'll|i'm|let me|now i|i will|going to|proceeding to)/i.test(response);
    
    if (hasQuestionMark && !isProgressUpdate) {
      for (const pattern of this.PATTERN_MATCHERS.permission_request) {
        if (pattern.test(response)) {
          patterns.push({
            type: 'permission_request',
            confidence: 0.9,
            details: 'Agent is asking for permission to proceed',
            suggestedResponse: 'Yes, please proceed'
          });
          break;
        }
      }
    }

    for (const pattern of this.PATTERN_MATCHERS.data_needed) {
      const match = pattern.exec(response);
      if (match) {
        const neededData = match[1] || 'data';
        patterns.push({
          type: 'data_needed',
          confidence: 0.85,
          details: `Agent needs: ${neededData}`,
          suggestedResponse: `Yes, please retrieve the ${neededData} from the system and use it`
        });
        break;
      }
    }

    const hasCompletionIndicators = /(?:successfully|created|updated|modified|changed|customized).*(?:project|resource|item)/i.test(response);
    if (!hasCompletionIndicators) {
      for (const pattern of this.PATTERN_MATCHERS.suggestion) {
        if (pattern.test(response)) {
          patterns.push({
            type: 'suggestion',
            confidence: 0.8,
            details: 'Agent is suggesting an alternative approach',
            suggestedResponse: 'Yes, please try that approach'
          });
          break;
        }
      }
    }

    for (const pattern of this.PATTERN_MATCHERS.partial_success) {
      if (pattern.test(response)) {
        patterns.push({
          type: 'partial_success',
          confidence: 0.85,
          details: 'Agent completed part of the task',
          suggestedResponse: 'Continue with the next step'
        });
        break;
      }
    }

    for (const pattern of this.PATTERN_MATCHERS.error) {
      if (pattern.test(response)) {
        patterns.push({
          type: 'error',
          confidence: 0.9,
          details: 'Agent encountered an error',
          suggestedResponse: undefined
        });
      }
    }

    for (const pattern of this.PATTERN_MATCHERS.completed) {
      if (pattern.test(response)) {
        patterns.push({
          type: 'completed',
          confidence: 0.95,
          details: 'Task appears to be completed',
          suggestedResponse: undefined
        });
      }
    }

    if (patterns.length === 0 && response.includes('?')) {
      patterns.push({
        type: 'permission_request',
        confidence: 0.6,
        details: 'Possible question or request for confirmation',
        suggestedResponse: 'Yes, please proceed'
      });
    }

    return patterns;
  }

  generateFollowUpPrompt(
    patterns: ResponsePattern[],
    conversationState: ConversationState,
    originalTask: string
  ): string | null {
    if (conversationState.turnCount >= this.MAX_TURNS) {
      console.log(`Reached maximum conversation turns (${this.MAX_TURNS})`);
      return null;
    }

    const primaryPattern = patterns.reduce((prev, current) => 
      current.confidence > prev.confidence ? current : prev
    , patterns[0]);

    if (!primaryPattern) {
      return null;
    }

    switch (primaryPattern.type) {
      case 'permission_request':
        return primaryPattern.suggestedResponse || 'Yes, please proceed with that approach';

      case 'data_needed':
        return primaryPattern.suggestedResponse || 
          'Yes, please retrieve the required data from the system and then execute the action';

      case 'suggestion':
        return primaryPattern.suggestedResponse || 'Yes, that sounds good. Please try that';

      case 'partial_success':
        return primaryPattern.suggestedResponse || 'Great! Please continue with the remaining steps';

      case 'completed':
        return null;

      case 'error':
        if (conversationState.turnCount < this.MAX_TURNS - 1) {
          return 'I see there was an error. Can you try a different approach or check if the required resources exist?';
        }
        return null;

      default:
        return null;
    }
  }

  isConversationComplete(
    patterns: ResponsePattern[],
    conversationState: ConversationState
  ): boolean {
    if (conversationState.turnCount >= this.MAX_TURNS) {
      return true;
    }

    const hasCompletedPattern = patterns.some(p => p.type === 'completed' && p.confidence > 0.8);
    if (hasCompletedPattern) {
      return true;
    }

    const hasHighConfidenceError = patterns.some(p => p.type === 'error' && p.confidence > 0.8);
    if (hasHighConfidenceError && conversationState.turnCount >= 3) {
      return true;
    }

    if (this.detectRepetitivePatterns(conversationState)) {
      return true;
    }

    return false;
  }

  private detectRepetitivePatterns(state: ConversationState): boolean {
    if (state.turns.length < 4) {
      return false;
    }

    const recentTurns = state.turns.filter(t => t.role === 'assistant').slice(-2);
    if (recentTurns.length === 2) {
      const similarity = this.calculateSimilarity(recentTurns[0].content, recentTurns[1].content);
      if (similarity > 0.8) {
        console.log('Detected repetitive responses from agent');
        return true;
      }
    }

    return false;
  }

  private calculateSimilarity(str1: string, str2: string): number {
    const words1 = new Set(str1.toLowerCase().split(/\s+/));
    const words2 = new Set(str2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  createInitialState(): ConversationState {
    return {
      turns: [],
      status: 'initial',
      taskCompleted: false,
      turnCount: 0
    };
  }

  addTurn(
    state: ConversationState,
    role: 'user' | 'assistant',
    content: string,
    patterns?: ResponsePattern[]
  ): ConversationState {
    const newTurn: ConversationTurn = {
      role,
      content,
      timestamp: Date.now(),
      patterns
    };

    return {
      ...state,
      turns: [...state.turns, newTurn],
      turnCount: state.turnCount + (role === 'assistant' ? 1 : 0)
    };
  }

  updateStatus(state: ConversationState, status: ConversationState['status']): ConversationState {
    return {
      ...state,
      status
    };
  }

  extractFinalResult(state: ConversationState): {
    success: boolean;
    output?: string;
    error?: string;
    extractedData?: any;
  } {
    const lastAssistantTurn = [...state.turns]
      .reverse()
      .find(t => t.role === 'assistant');

    if (!lastAssistantTurn) {
      return {
        success: false,
        error: 'No assistant response found'
      };
    }

    const patterns = lastAssistantTurn.patterns || [];
    const hasSuccess = patterns.some(p => 
      (p.type === 'completed' || p.type === 'partial_success') && p.confidence > 0.7
    );
    const hasError = patterns.some(p => p.type === 'error' && p.confidence > 0.7);

    return {
      success: hasSuccess && !hasError,
      output: lastAssistantTurn.content,
      error: hasError ? state.lastError || 'Task failed' : undefined,
      extractedData: state.extractedData
    };
  }
}
