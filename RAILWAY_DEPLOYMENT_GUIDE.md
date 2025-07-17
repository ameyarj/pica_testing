# Railway Deployment Guide for Pica Platform Testing

## Why Railway is Perfect for This Application

Your Pica Platform Testing application is an **interactive CLI tool** that requires user input for:
- Platform selection
- Test strategy configuration
- Batch size settings
- Real-time monitoring

Railway provides **interactive terminal access** that makes this possible in the cloud!

## Prerequisites
- GitHub repository with your code
- Railway account (free tier available)
- Required environment variables

## Step-by-Step Deployment Process

### 1. Prepare Your Repository
Make sure all changes are committed and pushed:
```bash
git add .
git commit -m "Prepare for Railway deployment"
git push origin main
```

### 2. Deploy to Railway

#### Option A: Using Railway CLI (Recommended)
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Deploy from your project directory
railway deploy

# Link to your project
railway link
```

#### Option B: Using Railway Dashboard
1. Go to [Railway Dashboard](https://railway.app/)
2. Click "Deploy from GitHub repo"
3. Select your repository
4. Railway will automatically detect the configuration

### 3. Configure Environment Variables
In Railway dashboard or via CLI:

```bash
# Set environment variables
railway variables set NODE_ENV=production
railway variables set PICA_SECRET_KEY=your_pica_secret_key
railway variables set PICA_USER_TOKEN=your_pica_user_token
railway variables set OPENAI_API_KEY=your_openai_api_key
railway variables set ANTHROPIC_API_KEY=your_anthropic_api_key
```

Or in Railway Dashboard:
- Go to your project → Variables
- Add each environment variable:
  - `NODE_ENV` = `production`
  - `PICA_SECRET_KEY` = `your_pica_secret_key`
  - `PICA_USER_TOKEN` = `your_pica_user_token`
  - `OPENAI_API_KEY` = `your_openai_api_key`
  - `ANTHROPIC_API_KEY` = `your_anthropic_api_key`

### 4. Access Your Interactive Application

#### Method 1: Railway Dashboard Shell
1. Go to your Railway project dashboard
2. Click on your service
3. Click "Shell" or "Terminal" tab
4. You'll get a web-based terminal connected to your running app
5. Interact with your CLI exactly as you would locally!

#### Method 2: Railway Connect (Local Terminal)
```bash
# Connect to your running service
railway connect

# Your local terminal now connects to the cloud instance
# All interactions happen in the cloud but feel local
```

#### Method 3: Railway Run (Execute Commands)
```bash
# Run your application
railway run npm start

# Or execute specific commands
railway run npm run dev
```

## Application Features on Railway

### Interactive Terminal Access
- **Real-time interaction**: Select platforms, configure batches, monitor progress
- **Full readline support**: All your prompts work perfectly
- **Live logging**: See execution logs in real-time
- **Interrupt handling**: Ctrl+C works as expected

### Persistent Storage
- **Data persistence**: All context files, logs, and reports are saved
- **Crash recovery**: Resume interrupted batches automatically
- **Cross-session data**: Access previous test results and contexts

### Scalability
- **Automatic scaling**: Railway handles resource management
- **Memory management**: Efficient handling of large test batches
- **Process management**: Automatic restarts on failures

## Usage Examples

### Starting a Test Session
```bash
# Connect to your Railway service
railway connect

# Your app starts and shows:
# 🔗 Available Platforms for Testing:
#  1. Google Workspace
#  2. Microsoft 365
#  3. Slack
# ➡️ Select a platform by number (or type "exit"): 

# Choose your platform and configure tests interactively!
```

### Monitoring and Logs
```bash
# View real-time logs
railway logs

# Follow logs continuously
railway logs --follow

# View service status
railway status
```

### Managing Your Service
```bash
# Restart your service
railway restart

# Check service information
railway info

# View environment variables
railway variables
```

## File Structure in Railway
```
/app  (your application directory)
├── data/
│   ├── contexts/          # Context files (persistent)
│   │   ├── platform_batch_1_context.json
│   │   ├── platform_batch_1_compact.json
│   │   └── ...
│   └── logs/              # Log files (persistent)
│       ├── platform.json
│       ├── platform_summary.md
│       └── ...
├── knowledge/             # Refined knowledge files
├── src/                   # Your source code
└── dist/                  # Built JavaScript files
```

## Troubleshooting

### Common Issues

**1. Environment Variables Not Set**
```bash
# Check variables
railway variables

# Set missing variables
railway variables set VARIABLE_NAME=value
```

**2. Build Failures**
```bash
# Check build logs
railway logs --deployment

# Rebuild
railway redeploy
```

**3. Interactive Terminal Not Working**
- Use Railway dashboard shell instead of CLI
- Ensure your service is running
- Check if readline is properly configured

### Performance Tips

**1. Optimize Batch Sizes**
- Start with smaller batches (25-50 actions)
- Monitor memory usage in Railway dashboard
- Scale up gradually based on performance

**2. Monitor Resource Usage**
- Check Railway dashboard metrics
- Watch memory and CPU usage during testing
- Adjust batch sizes if needed

**3. Persistent Data Management**
- Regularly clean up old context files
- Archive completed test results
- Monitor disk usage

## Advanced Configuration

### Custom Railway Configuration
The `railway.toml` file provides advanced configuration:

```toml
[build]
builder = "NIXPACKS"
buildCommand = "npm ci && npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

### Environment-Specific Settings
Railway automatically sets `RAILWAY_ENVIRONMENT_NAME` which the app uses for:
- Persistent storage configuration
- Logging optimization
- Resource management

## Cost Optimization

### Railway Pricing Tiers
- **Hobby Plan**: $5/month - Perfect for development and small teams
- **Pro Plan**: $20/month - Production use with more resources
- **Team Plan**: $20/month per member - Collaborative testing

### Resource Management
- **CPU Usage**: Mainly during LLM calls and analysis
- **Memory Usage**: Scales with batch size and context complexity
- **Network**: API calls to Pica, OpenAI, and Anthropic
- **Storage**: Context files, logs, and reports

## Security Considerations

### Environment Variables
- Never commit API keys to repository
- Use Railway's secure variable storage
- Regularly rotate API keys

### Network Security
- Railway provides HTTPS by default
- All API communications are encrypted
- Secure environment isolation

## Support and Community

### Getting Help
- Railway Discord: Active community support
- Railway Documentation: Comprehensive guides
- GitHub Issues: For application-specific problems

### Best Practices
- Test with smaller batches initially
- Monitor resource usage regularly
- Use meaningful commit messages for deployments
- Keep dependencies updated

---

## Summary

Railway deployment provides the perfect environment for your interactive CLI application:

✅ **Interactive terminal access** - Full CLI experience in the cloud
✅ **Persistent storage** - All data survives restarts and deployments  
✅ **Easy deployment** - Simple git-based deployment process
✅ **Scalable resources** - Automatically handles varying workloads
✅ **Real-time monitoring** - Live logs and performance metrics
✅ **Cost-effective** - Pay only for what you use

Your Pica Platform Testing application is now ready for cloud deployment with full interactive capabilities!
