# Pica Platform Testing Suite

An advanced, intelligent testing framework that automatically tests all API actions across multiple platforms integrated with PicaOS. The system uses sophisticated AI models, batch processing, and context persistence to ensure comprehensive testing coverage with detailed reporting and cost tracking.

## 🚀 Key Features

### **Advanced Batch Processing System**
- **Configurable Batch Sizes**: Choose optimal batch sizes (1-200 actions) for different platform scales
- **Intelligent Batch Management**: Automatically handles batch sequencing and dependency resolution
- **Session Persistence**: Resume interrupted batches from exactly where you left off
- **Progress Tracking**: Real-time progress monitoring with detailed execution state

### **Smart Dependency Analysis**
- **AI-Powered Dependency Detection**: Uses Claude/GPT models to analyze action dependencies
- **Chunked Processing**: Handles large action sets through intelligent chunking
- **Cross-Chunk Dependency Resolution**: Maintains dependencies across different batch chunks
- **Execution Planning**: Generates optimal execution plans with parallelizable groups

### **Enhanced Context Management**
- **Session-Aware Context**: Maintains comprehensive context across batch executions
- **Context Compression**: Automatically compresses large contexts for memory efficiency
- **Context Persistence**: Saves and loads context between sessions
- **Resource Tracking**: Tracks all created resources and their extracted IDs

### **Advanced AI Integration**
- **Multiple AI Provider Support**: Anthropic Claude, OpenAI GPT models with automatic fallback
- **Dynamic Model Selection**: Chooses optimal models based on task complexity
- **Cost Optimization**: Tracks token usage and costs across all AI operations
- **Rate Limit Management**: Intelligent rate limit handling with user choice options

### **Sophisticated Prompt Generation**
- **LLM-Powered Prompt Generation**: Uses AI to generate human-like, context-aware prompts
- **Adaptive Prompt Strategies**: Switches between conversational, technical, and contextual approaches
- **Prompt Pattern Learning**: Learns from successful prompts to improve future generations
- **Platform-Specific Terminology**: Adapts prompts to platform-specific language and workflows

### **Token Action Detection & Safety**
- **Automatic Token Action Detection**: Identifies and skips potentially destructive token-related actions
- **Smart Categorization**: Categorizes actions by risk level (token-destructive, token-sensitive, etc.)
- **Safety Reporting**: Provides detailed reports on skipped actions and reasons

### **Comprehensive Logging & Reporting**
- **Multi-Format Logging**: JSON logs, Markdown reports, and real-time console output
- **Cost Tracking**: Detailed cost analysis per model, component, and operation
- **Success Analytics**: Track success rates, failure patterns, and improvement metrics
- **Session History**: Maintain complete history of all testing sessions

### **Production-Ready Features**
- **Railway Deployment Support**: Configured for cloud deployment with Railway
- **Graceful Interrupt Handling**: Safely saves state on interruption (Ctrl+C)
- **Error Recovery**: Comprehensive error handling and recovery mechanisms
- **Memory Management**: Efficient memory usage with automatic cleanup

## 📋 Prerequisites

- **Node.js** v18+ and npm
- **ts-node** installed globally (`npm install -g ts-node`) or available via npx
- **PicaOS Account** with API access
- **Required API Keys**:
  - **Pica User Token** (from PicaOS dashboard)
  - **Pica Secret Key** (from PicaOS dashboard)
  - **AI Provider API Key** (at least one):
    - **Anthropic API Key** (for Claude models) - recommended
    - **OpenAI API Key** (for GPT models) - alternative/fallback

## 🔧 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/pica-com/automated-knowledge-tester
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create a `.env` file:**
   ```env
   # Required - PicaOS Credentials
   PICA_SECRET_KEY=your_pica_secret_key
   PICA_USER_TOKEN=your_pica_user_token

   # AI Provider (at least one required)
   ANTHROPIC_API_KEY=your_anthropic_api_key  # Recommended
   OPENAI_API_KEY=your_openai_api_key        # Alternative/Fallback
   ```

## 🏃 Running the Test Suite

### Development Mode
```bash
npx ts-node src/main_runner.ts
```

### Production Build
```bash
npm run build
npm start
```

### Railway Deployment
```bash
railway login                      #use connectors@picos.com
railway link                       
railway connect                    # choose automated_platform_tester
railway ssh
npx ts-node src/main_runner.ts 
```

## 📂 Accessing Test Data on Railway

When you run tests on Railway, all data is stored in the cloud and persists across deployments. Here's how to access your test data:

### 📍 Data Storage Locations

Your test data is organized in these directories on Railway:

```
/app/
├── data/
│   ├── contexts/           # Context files (batch data, resources, IDs)
│   │   ├── Platform_batch_1_context.json
│   │   ├── Platform_batch_1_interrupt.json
│   │   └── Platform_batch_1_compact.json
│   └── logs/              # Execution logs and summaries
│       ├── Platform.json
│       └── Platform_summary.md
├── knowledge/
│   └── Platform/          # Refined knowledge files
│       ├── action_knowledge_1.md
│       └── action_knowledge_2.md
└── logs/
    └── history/           # Batch execution history
        └── Platform_history.json
```

### 🔍 Viewing Data on Railway

#### Option 1: Railway SSH Access
```bash
# Connect to Railway via SSH
railway ssh

# Navigate to data directories
cd /app/data/contexts/
ls -la                     # View context files

cd /app/data/logs/
ls -la                     # View execution logs

cd /app/knowledge/
ls -la                     # View knowledge files

cd /app/logs/history/
ls -la                     # View history files
```

### 📥 Downloading Data Locally

#### Method 1: View and Copy Individual Files
```bash
# SSH into Railway
railway ssh

# View file contents (copy-paste to save locally)
cat /app/data/logs/Platform_summary.md
cat /app/data/contexts/Platform_batch_1_context.json
cat /app/logs/history/Platform_history.json
```

#### Method 2: Railway CLI File Access
```bash
# Execute commands remotely and save output locally
railway run cat /app/data/logs/Platform_summary.md > local_summary.md
railway run cat /app/data/contexts/Platform_batch_1_context.json > local_context.json
railway run cat /app/logs/history/Platform_history.json > local_history.json
```

#### Method 3: Bulk Download Script
```bash
# Create a simple download script
railway ssh

# Create a temporary archive
tar -czf /tmp/test_data.tar.gz /app/data /app/knowledge /app/logs/history

# Copy the archive (you'll need to copy the output manually)
base64 /tmp/test_data.tar.gz
```

### 📋 Understanding the Data Files

#### Context Files (`/app/data/contexts/`)
- **`Platform_batch_N_context.json`**: Complete batch execution context
- **`Platform_batch_N_interrupt.json`**: Recovery data for interrupted batches
- **`Platform_batch_N_compact.json`**: Compressed context for memory efficiency

#### Log Files (`/app/data/logs/`)
- **`Platform.json`**: Detailed execution logs with timestamps
- **`Platform_summary.md`**: Human-readable test summary report

#### Knowledge Files (`/app/knowledge/Platform/`)
- **`action_knowledge_N.md`**: Refined knowledge for individual actions
- **`failed_action_knowledge_N.md`**: Knowledge from failed actions

#### History Files (`/app/logs/history/`)
- **`Platform_history.json`**: Complete session history and checkpoints

### 🔄 Data Persistence

- ✅ **Survives app restarts**: All data persists across Railway deployments
- ✅ **Cross-session access**: Previous test results available in future sessions
- ✅ **Automatic backups**: Railway handles infrastructure-level backups
- ✅ **Version control**: Context files maintain execution history

### 💡 Quick Data Access Tips

```bash
# Find all JSON files
find /app -name "*.json" | grep -E "(context|log|history)"

# Find all markdown files
find /app -name "*.md"

# View latest batch context
ls -t /app/data/contexts/*.json | head -1 | xargs cat

# View latest summary report
ls -t /app/data/logs/*_summary.md | head -1 | xargs cat

# Check total data size
du -sh /app/data /app/knowledge /app/logs/history
```

## 📁 Project Structure

```
src/
├── main_runner.ts                 # Application entry point
├── orchestrator.ts                # Main orchestration logic
├── agent_service.ts               # AI agent service management
├── batch_manager.ts               # Batch processing and management
├── enhanced_context_manager.ts    # Context management and persistence
├── dependency_analyzer.ts         # Action dependency analysis
├── prompt_generator.ts            # AI-powered prompt generation
├── knowledge_refiner.ts           # Knowledge refinement system
├── execution_logger.ts            # Comprehensive logging system
├── global_token_tracker.ts        # Global token usage tracking
├── testing_history_manager.ts     # Session history management
├── context_persistence_manager.ts # Context serialization/storage
├── conversation_handler.ts        # Conversation flow management
├── rate_limit_manager.ts          # Rate limiting and retry logic
├── enhanced_model_selector.ts     # AI model selection logic
├── platform_usecase_analyzer.ts   # Platform-specific analysis
├── path_resolver.ts               # Dynamic path parameter resolution
├── connectors/
│   └── pica_api_service.ts        # PicaOS API integration
├── interfaces/
│   ├── interface.ts               # Core type definitions
│   ├── compact_context.ts         # Context compression types
│   └── prompt_generation.ts       # Prompt generation types
└── utils/
    ├── tokenTrackerUtils.ts       # Token tracking utilities
    ├── tokenActionDetector.ts     # Token action detection
    ├── context_compressor.ts      # Context compression logic
    ├── resourceExtractor.ts       # Resource extraction utilities
    ├── pathUtils.ts               # Path manipulation utilities
    └── modelInitializer.ts        # Model initialization utilities
```

## 🎯 How It Works

### 1. **Platform Selection**
- Lists all available PicaOS platforms
- Displays platform statistics and previous testing history
- Supports platform-specific configuration

### 2. **Batch Configuration**
- Choose batch size (1-200 actions) based on platform scale
- Select execution strategy:
  - **Run all actions**: Fresh dependency-ordered execution
  - **Continue from last batch**: Resume from previous session
  - **Test specific range**: Target specific action ranges
  - **Re-run failed actions**: Retry only previously failed actions
  - **Custom selection**: Keyword/name-based action selection

### 3. **Dependency Analysis**
- AI-powered analysis of action dependencies
- Chunked processing for large action sets
- Cross-chunk dependency resolution
- Fallback rule-based analysis

### 4. **Intelligent Execution**
- **Pass 1**: Dependency-ordered execution with optimal batching
- **Pass 2**: Enhanced context retry for failed actions
- **Smart Token Detection**: Automatic skipping of risky token actions
- **Rate Limit Handling**: Intelligent rate limit management

### 5. **Comprehensive Reporting**
- Real-time progress monitoring
- Detailed success/failure analysis
- Cost tracking and optimization insights
- Session history and recovery information

## 🧠 AI Model Support

### Primary Models
- **claude-4-sonnet**: Default model for most operations
- **gpt-4.1**: OpenAI model for large contexts

### Automatic Model Selection
- **Task Complexity**: Chooses appropriate model based on task requirements
- **Token Limits**: Automatically switches models for large inputs
- **Cost Optimization**: Balances performance with cost efficiency
- **Fallback Support**: Graceful degradation when primary models unavailable

## 📊 Understanding the Output

### Real-time Indicators
- ✅ **SUCCESS**: Action completed successfully
- ❌ **FAILED**: Action failed (will retry in Pass 2)
- ⛔ **PERMISSION ERROR**: Authentication/permission issue (no retry)
- 🚫 **SKIPPED**: Token action automatically skipped for safety
- 💡 **REFINING**: Knowledge refinement in progress

### Batch Progress
- **Batch Information**: Current batch number, range, and progress
- **Dependency Status**: Shows which dependencies are met/missing
- **Context Loading**: Indicates when context is loaded from previous batches
- **Token Usage**: Real-time token consumption and cost tracking

### Final Summary Reports
- **Success Rate Analysis**: Overall and per-pass success rates
- **Token Action Report**: Detailed breakdown of skipped actions
- **Cost Breakdown**: Per-model and per-component cost analysis
- **Failure Analysis**: Categorized failure reasons and recommendations
- **Session Recovery**: Information for resuming interrupted sessions

## 🔄 Session Management

### Automatic Checkpointing
- **Progress Saving**: Automatically saves progress every 30 seconds
- **Context Persistence**: Maintains context across interruptions
- **State Recovery**: Resume from exact interruption point
- **History Tracking**: Complete session history with timestamps

### Interrupt Handling
- **Graceful Shutdown**: Ctrl+C triggers safe state saving
- **Context Preservation**: All context and progress data preserved
- **Resume Capability**: Seamless resumption from interruption point
- **Error Recovery**: Robust error handling and recovery mechanisms

## ⚙️ Advanced Configuration

### Batch Size Optimization
- **Small Platforms** (< 100 actions): 25-50 batch size
- **Medium Platforms** (100-500 actions): 50-75 batch size
- **Large Platforms** (500+ actions): 75-100 batch size
- **Memory Constrained**: Use smaller batches (25-50)

### Cost Optimization
- **Model Selection**: Choose cost-effective models for simple tasks
- **Batch Sizing**: Optimize batch sizes to reduce context overhead
- **Token Tracking**: Monitor and optimize token usage patterns
- **Context Compression**: Automatic compression of large contexts

## 🚨 Troubleshooting

### Common Issues
- **Permission Errors**: Check PicaOS integration permissions and token scopes
- **Rate Limits**: System automatically handles rate limits with user choice
- **Memory Issues**: Reduce batch size or enable context compression
- **Token Skipping**: Review skipped actions report for safety reasons

### Recovery Options
- **Session Resume**: Use "Continue from last batch" option
- **Context Recovery**: System automatically loads required context
- **Failed Action Retry**: Use "Re-run failed actions" for targeted retries
- **Fresh Start**: Use "Run all actions" for complete reset

## 🔐 Security & Best Practices

### Security Measures
- **Token Safety**: Automatic detection and skipping of destructive token actions
- **Environment Variables**: Secure API key management
- **Context Encryption**: Sensitive data protection in stored contexts
- **Permission Validation**: Comprehensive permission checking

### Best Practices
- **Regular Key Rotation**: Rotate API keys periodically
- **Batch Size Management**: Use appropriate batch sizes for your platform
- **Context Cleanup**: Regular cleanup of old session data
- **Cost Monitoring**: Monitor token usage and costs regularly


## 🤝 Contributing

This is a specialized testing framework for PicaOS integration. For issues or enhancements, please contact the ameya Raj or submit issues through the repository.
