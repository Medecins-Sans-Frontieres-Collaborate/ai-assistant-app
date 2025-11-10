# OpenTelemetry Integration

This application uses OpenTelemetry for comprehensive observability with Azure Monitor Application Insights.

## Features

✅ **Automatic Instrumentation** (Next.js 16)

- HTTP request tracing
- Database query spans
- External API call tracking
- Routing and rendering metrics
- Turbopack build metrics
- Cache hit/miss tracking

✅ **Custom Spans** for business logic

- AI Foundry Agent execution
- RAG (Retrieval-Augmented Generation) enrichment
- File processing (download, transcription, summarization)
- Chat completion execution
- Tool routing decisions
- Web search execution
- Tone application

✅ **Business Metrics** (MetricsService)

- Token usage tracking per user, department, company
- Request duration and success/failure rates
- File processing metrics
- Error tracking and categorization
- Cost estimation per request

✅ **Console Log Capture**

- All `console.log`, `console.error`, `console.warn` are automatically captured
- Automatically correlated with traces
- No code changes needed

## Setup

### 1. Environment Configuration

Add your Application Insights connection string to `.env.local`:

```bash
APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=xxx;IngestionEndpoint=https://xxx.in.applicationinsights.azure.com/;LiveEndpoint=https://xxx.livediagnostics.monitor.azure.com/;ApplicationId=xxx"
```

### 2. Get Your Connection String

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to your Application Insights resource
3. Copy the **Connection String** from the Overview page

### 3. Verify Setup

The `instrumentation.ts` file is automatically loaded by Next.js 16 on startup.

Check the console for:

```
[OpenTelemetry] Initializing with Azure Monitor...
[OpenTelemetry] Successfully initialized
```

## Viewing Telemetry

### Azure Monitor Application Insights

1. **Navigate to Azure Portal** → Your Application Insights resource

2. **View Traces:**
   - Go to **Transaction search** or **Performance** tab
   - Filter by operation name to see specific spans:
     - `ai_foundry_agent.chat` - Agent chat completions
     - `rag.enrich` - RAG enrichment
     - `file.process` - File processing
     - `chat.execute` - Standard chat execution

3. **View Logs:**
   - Go to **Logs** tab
   - Query with KQL (Kusto Query Language):
     ```kql
     traces
     | where timestamp > ago(1h)
     | where message contains "ChatHandler"
     | order by timestamp desc
     ```

4. **Application Map:**
   - View **Application Map** to see dependency visualization
   - Shows AI Foundry, Azure Search, Blob Storage connections

5. **Performance:**
   - **Performance** tab shows request latency distribution
   - Drill into slow requests to see span timings

### Grafana Integration

#### Option A: Azure Monitor Data Source (Recommended)

1. Add Azure Monitor datasource in Grafana
2. Use Application Insights as the data source
3. Query using KQL directly in Grafana panels

#### Option B: OpenTelemetry Backend (Advanced)

For more advanced setups:

- Export to Prometheus (metrics)
- Export to Loki (logs)
- Export to Tempo (traces)

## Custom Span Attributes

### AI Foundry Agent Spans

```typescript
Attributes:
- agent.id: Agent ID
- agent.model: Model name
- message.count: Number of messages
- message.temperature: Temperature setting
- user.id: User ID
- bot.id: Bot/knowledge base ID
- thread.id: Thread ID
- thread.is_new: Whether thread was created
- response.stream: Whether streaming response
```

### File Processing Spans

```typescript
Attributes:
- user.id: User ID
- model.id: Model used for processing
- file.count: Number of files processed
- file.summaries_count: Number of summaries generated
- file.transcripts_count: Number of transcripts generated
- file.images_count: Number of images processed
```

### RAG Enrichment Spans

```typescript
Attributes:
- bot.id: Bot ID
- search.endpoint: Azure Search endpoint
- search.index: Search index name
- rag.enabled: Whether RAG is enabled
- rag.file_summaries_count: File summaries added
- rag.transcripts_count: Transcripts added
- rag.enriched_messages_count: Total enriched messages
```

### Chat Execution Spans

```typescript
Attributes:
- chat.model: Model ID
- chat.message_count: Number of messages
- chat.stream: Streaming enabled
- chat.has_rag: RAG enabled
- chat.has_files: Files present
- chat.has_images: Images present
- user.id: User ID
- user.email: User email
- user.department: User department
- user.company: User company
- user.job_title: User job title
- chat.final_message_count: Final message count after processing
- chat.duration_ms: Chat execution duration
```

### Tool Router Spans

```typescript
Attributes:
- tool_router.force_web_search: Whether search was forced
- tool_router.message_length: Query message length
- tool_router.decision: Routing decision (forced_web_search, etc.)
- tool_router.needs_web_search: AI decision result
- tool_router.search_query: Generated search query
- tool_router.reasoning: Decision reasoning
```

### Agent Web Search Spans

```typescript
Attributes:
- search.query: Search query text
- search.query_length: Query length
- search.model: Model used for search
- search.result_length: Result text length
- search.citations_count: Number of citations
- user.id: User ID
- user.email: User email
- user.department: User department
- user.company: User company
```

### Tone Service Spans

```typescript
Attributes:
- user.id: User ID
- tone.has_tone_id: Whether message has tone
- tone.id: Tone ID
- tone.name: Tone name
- tone.applied: Whether tone was applied
- tone.reason: Reason if not applied
- tone.voice_rules_length: Length of voice rules
- tone.count: Number of user tones (for getUserTones)
```

## Example Queries

### Find Slow Chat Requests

```kql
requests
| where name == "POST /api/chat"
| where duration > 5000  // > 5 seconds
| order by duration desc
| project timestamp, duration, operation_Id, customDimensions
```

### View File Processing Errors

```kql
dependencies
| where name == "file.process"
| where success == false
| order by timestamp desc
| project timestamp, name, duration, resultCode, customDimensions
```

### Agent Chat Success Rate

```kql
dependencies
| where name == "ai_foundry_agent.chat"
| summarize
    total = count(),
    failures = countif(success == false),
    success_rate = (count() - countif(success == false)) * 100.0 / count()
    by bin(timestamp, 1h)
| order by timestamp desc
```

### Console Logs with Trace Context

```kql
traces
| where message contains "[AIFoundryAgentHandler]"
| project timestamp, message, operation_Id, severityLevel
| order by timestamp desc
```

## Troubleshooting

### Telemetry not appearing in Azure Monitor

1. **Check connection string:**

   ```bash
   echo $APPLICATIONINSIGHTS_CONNECTION_STRING
   ```

2. **Verify instrumentation loaded:**
   Check server console for initialization message

3. **Wait 1-3 minutes:**
   Telemetry can take 1-3 minutes to appear in Azure Portal

4. **Check for errors:**
   Look for OpenTelemetry errors in server logs

### Missing custom spans

1. **Verify tracer initialization:**
   Each service should have `private tracer = trace.getTracer('service-name')`

2. **Check span wrapping:**
   Ensure async operations are wrapped in `startActiveSpan`

## Performance Impact

OpenTelemetry has minimal overhead:

- **Automatic instrumentation:** ~1-2% CPU overhead
- **Custom spans:** Negligible (< 0.5ms per span)
- **Console log capture:** No additional overhead

Sampling can be configured if needed (not currently implemented).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Next.js 16 Application                                  │
├─────────────────────────────────────────────────────────┤
│ instrumentation.ts (@vercel/otel)                       │
│   ├─ Auto: HTTP, DB, External APIs                     │
│   ├─ Auto: Next.js routing & rendering                 │
│   ├─ Auto: Console logs                                │
│   ├─ Custom: AI Foundry spans                          │
│   ├─ Custom: RAG enrichment spans                      │
│   ├─ Custom: File processing spans                     │
│   └─ Custom: Chat execution spans                      │
└────────────┬───────────────────────────────────────────┘
             │
             ├─ @azure/monitor-opentelemetry-exporter
             │
             └─> Azure Monitor Application Insights
                   ├─> Transaction Search (traces)
                   ├─> Performance (spans & timing)
                   ├─> Logs (console output)
                   ├─> Application Map (dependencies)
                   └─> Dashboards & Alerts
```

## Business Metrics

### MetricsService

The application includes a centralized `MetricsService` for tracking business metrics using OpenTelemetry Metrics API.

#### Token Usage Tracking

```typescript
MetricsService.recordTokenUsage(
  { prompt: 100, completion: 50, total: 150 },
  {
    user: session.user,
    model: 'gpt-4o',
    operation: 'chat', // or 'file_processing', 'agent', 'transcription'
    botId: 'optional-bot-id',
  },
);
```

**Attributes tracked:**

- `user.id`, `user.email`, `user.department`, `user.company`, `user.job_title`
- `model.id` - Model name
- `operation.type` - Type of operation
- `bot.id` - Bot/knowledge base ID (if applicable)
- `token.type` - 'total', 'prompt', or 'completion'

**Metrics recorded:**

- `tokens.usage` (Counter) - Total tokens consumed
- `tokens.cost` (Histogram) - Estimated cost in USD

#### Request Tracking

```typescript
MetricsService.recordRequest(
  'chat', // or 'file_upload', 'transcription', 'agent', 'rag'
  duration,
  {
    user: session.user,
    success: true,
    model: 'gpt-4o',
    botId: 'optional-bot-id',
  },
);
```

**Metrics recorded:**

- `requests.count` (Counter) - Total requests by type
- `request.duration` (Histogram) - Request duration distribution

#### File Processing Tracking

```typescript
MetricsService.recordFileProcessing(
  'document', // or 'audio', 'video', 'image'
  {
    user: session.user,
    success: true,
    fileSize: 1024000,
    processingTime: 5000,
    filename: 'document.pdf',
  },
);
```

#### Error Tracking

```typescript
MetricsService.recordError('chat_execution_failed', {
  user: session.user,
  operation: 'chat',
  model: 'gpt-4o',
  message: error.message,
});
```

**Metrics recorded:**

- `errors.count` (Counter) - Errors by type

### Querying Metrics in Azure Monitor

Metrics are exported to Azure Monitor and can be queried using KQL:

```kql
// Token usage by department
customMetrics
| where name == "tokens.usage"
| where customDimensions.["user.department"] != "unknown"
| summarize total_tokens = sum(value) by tostring(customDimensions.["user.department"])
| order by total_tokens desc

// Request success rate by operation
customMetrics
| where name == "requests.count"
| summarize
    total = count(),
    failures = countif(customDimensions.["operation.success"] == "false"),
    success_rate = (count() - countif(customDimensions.["operation.success"] == "false")) * 100.0 / count()
    by tostring(customDimensions.["operation.type"])
| order by total desc

// Average request duration by model
customMetrics
| where name == "request.duration"
| summarize avg_duration = avg(value) by tostring(customDimensions.["model.id"])
| order by avg_duration desc

// Estimated costs by user
customMetrics
| where name == "tokens.cost"
| where customDimensions.["user.email"] != "unknown"
| summarize total_cost = sum(value) by tostring(customDimensions.["user.email"])
| order by total_cost desc
```

## Next Steps

1. **Create Dashboards:**
   - Build custom dashboards in Azure Monitor or Grafana
   - Pin important metrics to workspace
   - Track token usage by department/company
   - Monitor cost trends

2. **Set Up Alerts:**
   - Alert on slow chat requests (> 10s)
   - Alert on file processing failures
   - Alert on high error rates
   - Alert on cost anomalies (unusual token usage)

3. **Optimize Based on Metrics:**
   - Identify high-cost operations
   - Find slow endpoints for optimization
   - Track user engagement patterns

4. **Sampling (if needed):**
   - Configure sampling for high-volume endpoints
   - Keep 100% sampling for errors
