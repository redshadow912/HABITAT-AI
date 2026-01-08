# Habitat AI - Deployment & Testing Guide

## Quick Start (Local Development)

### Prerequisites
- Node.js 18.x
- Azure Functions Core Tools v4
- Azure Storage Emulator (Azurite) or Azure Storage Account
- Azure Cosmos DB Emulator or Cosmos DB account

### 1. Install Dependencies
```bash
cd habitat-ai-backend
npm install
```

### 2. Configure Local Settings
Create `local.settings.json`:
```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "AzureWebJobsStorage__accountName": "your-account-name",
    "AzureWebJobsStorage__accountKey": "your-account-key",
    "COSMOS_DB_CONNECTION_STRING": "AccountEndpoint=https://localhost:8081/;AccountKey=C2y6yDjf5/R+...",
    "AI_VISION_ENDPOINT": "https://your-vision.cognitiveservices.azure.com/",
    "AI_VISION_KEY": "your-ai-vision-key"
  }
}
```

### 3. Build TypeScript
```bash
npm run build
```

### 4. Start Functions
```bash
npm start
```

Expected output:
```
Functions:
  DeleteObservation: [DELETE] http://localhost:7071/api/observations/{id}/{userId}
  EventGridProcessImage: eventGridTrigger
  GetObservations: [GET] http://localhost:7071/api/GetObservations
  GetUploadUrl: [POST] http://localhost:7071/api/GetUploadUrl
  ProcessImageUpload: blobTrigger
  UpdateObservation: [PUT] http://localhost:7071/api/observations/{id}
```

### 5. Open Frontend
```bash
# Open in browser
start frontend/index.html
```

## Testing the Valet Key Pattern

### Test 1: SAS Token Generation

**Endpoint**: POST `http://localhost:7071/api/GetUploadUrl`

**Request**:
```bash
curl -X POST http://localhost:7071/api/GetUploadUrl \
  -H "Content-Type: application/json" \
  -d '{"filename": "test.jpg", "filetype": "image/jpeg"}'
```

**Expected Response**:
```json
{
  "uploadUrl": "https://your-storage.blob.core.windows.net/raw-uploads/1234567890-test.jpg?sv=2022-11-02&...",
  "blobName": "1234567890-test.jpg",
  "message": "Upload this URL via PUT request"
}
```

**Validation**:
- ✅ Status code: 200
- ✅ uploadUrl contains SAS token (look for `?sv=` query parameter)
- ✅ Token expires in 5 minutes (check `se=` parameter)

### Test 2: Direct Upload to Blob Storage

**Using the SAS URL from Test 1**:
```bash
curl -X PUT "https://your-storage.blob.core.windows.net/raw-uploads/1234567890-test.jpg?sv=..." \
  -H "x-ms-blob-type: BlockBlob" \
  -H "Content-Type: image/jpeg" \
  -H "x-ms-meta-location: Test Location" \
  -H "x-ms-meta-uploadedby: tester" \
  --data-binary "@test.jpg"
```

**Expected Response**: HTTP 201 Created

**Validation**:
- ✅ File appears in Azure Storage Explorer
- ✅ Metadata is attached to blob

## Testing Event Grid (Local)

### Option 1: Use ngrok for Local Testing

1. **Install ngrok**:
   ```bash
   choco install ngrok
   # or
   npm install -g ngrok
   ```

2. **Start ngrok**:
   ```bash
   ngrok http 7071
   ```
   
   Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

3. **Create Event Grid Subscription in Azure Portal**:
   - Go to your Storage Account → Events
   - Create Event Subscription
   - Name: `habitat-local-test`
   - Event Type: Blob Created
   - Endpoint: Webhook
   - URL: `https://abc123.ngrok.io/runtime/webhooks/EventGrid?functionName=EventGridProcessImage`

4. **Upload a file and monitor**:
   ```bash
   # Check ngrok console for incoming requests
   # Check Azure Functions terminal for logs
   ```

### Option 2: Use Azure Storage Events (Production)

Skip ngrok and deploy to Azure (see deployment section below).

## Testing Event Grid Processing

### Manual Event Grid Test

**Endpoint**: POST `http://localhost:7071/runtime/webhooks/EventGrid?functionName=EventGridProcessImage`

**Request** (simulating Event Grid event):
```bash
curl -X POST http://localhost:7071/runtime/webhooks/EventGrid?functionName=EventGridProcessImage \
  -H "Content-Type: application/json" \
  -H "aeg-event-type: Notification" \
  -d '[{
    "id": "test-event-123",
    "eventType": "Microsoft.Storage.BlobCreated",
    "subject": "/blobServices/default/containers/raw-uploads/blobs/test.jpg",
    "eventTime": "2024-01-06T12:00:00.000Z",
    "data": {
      "url": "https://your-storage.blob.core.windows.net/raw-uploads/test.jpg"
    },
    "dataVersion": "",
    "metadataVersion": "1"
  }]'
```

**Expected Logs**:
```
=== Event Grid Trigger Fired ===
Event Type: Microsoft.Storage.BlobCreated
Processing blob: test.jpg
Downloaded blob, size: 12345 bytes
Calling Azure AI Vision API...
AI Analysis Complete: A red fox in the forest (92% confidence)
✅ Successfully saved observation to Cosmos DB
```

**Validation**:
- ✅ Function logs show successful processing
- ✅ New document appears in Cosmos DB
- ✅ Document has `processedBy: 'EventGrid'` field

## End-to-End Test

### Complete Upload → Process → Display Flow

1. **Open Frontend** (`frontend/index.html`)
2. **Click "Record" button**
3. **Select an image file**
4. **Enter location name**
5. **Click "Submit Observation"**

**Expected Flow**:
```
1. Toast: "Upload successful! AI is processing..."
2. Wait 3 seconds
3. Toast: "Check the feed for your observation!"
4. New card appears in feed
5. Map marker appears on map
```

**Console Logs** (F12 Developer Tools):
```javascript
// SAS Token Request
POST http://localhost:7071/api/GetUploadUrl
Response: { uploadUrl: "...", blobName: "..." }

// Direct Upload
PUT https://your-storage.blob.core.windows.net/raw-uploads/...
Response: 201 Created

// Fetch Updated Data
GET http://localhost:7071/api/GetObservations
Response: [{ id: "...", aiData: { description: "..." } }]
```

**Function Logs** (Terminal):
```
[GetUploadUrl] Generating SAS token...
[EventGridProcessImage] Event Grid trigger fired
[EventGridProcessImage] Processing blob: 1234-test.jpg
[EventGridProcessImage] AI Analysis Complete: Red fox
[EventGridProcessImage] ✅ Successfully saved to Cosmos DB
```

## Deployment to Azure

### 1. Create Azure Resources

```bash
# Variables
RESOURCE_GROUP="habitat-ai-rg"
LOCATION="eastus"
STORAGE_ACCOUNT="habitataistorage"
FUNCTION_APP="habitat-ai-functions"
COSMOS_ACCOUNT="habitat-ai-cosmos"

# Create Resource Group
az group create --name $RESOURCE_GROUP --location $LOCATION

# Create Storage Account
az storage account create \
  --name $STORAGE_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --sku Standard_LRS

# Create Function App
az functionapp create \
  --resource-group $RESOURCE_GROUP \
  --name $FUNCTION_APP \
  --storage-account $STORAGE_ACCOUNT \
  --consumption-plan-location $LOCATION \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4

# Create Cosmos DB
az cosmosdb create \
  --name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --locations regionName=$LOCATION

# Create Cosmos Database & Container
az cosmosdb sql database create \
  --account-name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --name habitat-db

az cosmosdb sql container create \
  --account-name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --database-name habitat-db \
  --name observations \
  --partition-key-path "/userId"
```

### 2. Configure Application Settings

```bash
# Get connection strings
STORAGE_CONN=$(az storage account show-connection-string \
  --name $STORAGE_ACCOUNT --resource-group $RESOURCE_GROUP \
  --query connectionString -o tsv)

COSMOS_CONN=$(az cosmosdb keys list \
  --name $COSMOS_ACCOUNT --resource-group $RESOURCE_GROUP \
  --type connection-strings \
  --query "connectionStrings[0].connectionString" -o tsv)

# Set Function App settings
az functionapp config appsettings set \
  --name $FUNCTION_APP \
  --resource-group $RESOURCE_GROUP \
  --settings \
    "COSMOS_DB_CONNECTION_STRING=$COSMOS_CONN" \
    "AI_VISION_ENDPOINT=https://your-vision.cognitiveservices.azure.com/" \
    "AI_VISION_KEY=your-key"
```

### 3. Deploy Function App

```bash
# Build
npm run build

# Deploy
func azure functionapp publish $FUNCTION_APP
```

### 4. Create Event Grid Subscription

```bash
# Get Storage Account ID
STORAGE_ID=$(az storage account show \
  --name $STORAGE_ACCOUNT --resource-group $RESOURCE_GROUP \
  --query id -o tsv)

# Get Function ID
FUNCTION_ID=$(az functionapp function show \
  --name $FUNCTION_APP --resource-group $RESOURCE_GROUP \
  --function-name EventGridProcessImage \
  --query id -o tsv)

# Create Event Subscription
az eventgrid event-subscription create \
  --name habitat-blob-processing \
  --source-resource-id $STORAGE_ID \
  --endpoint $FUNCTION_ID \
  --endpoint-type azurefunction \
  --included-event-types Microsoft.Storage.BlobCreated
```

### 5. Deploy Static Website

```bash
# Enable static website hosting
az storage blob service-properties update \
  --account-name $STORAGE_ACCOUNT \
  --static-website \
  --index-document index.html

# Upload frontend
az storage blob upload \
  --account-name $STORAGE_ACCOUNT \
  --container-name '$web' \
  --name index.html \
  --file frontend/index.html
```

### 6. Update Frontend API URL

Edit `frontend/index.html`:
```javascript
const API_BASE = "https://habitat-ai-functions.azurewebsites.net/api";
```

## Monitoring & Debugging

### View Function Logs (Live)

**Azure Portal**:
1. Function App → Monitor → Live Metrics
2. Function App → Log Stream

**CLI**:
```bash
az functionapp log tail --name $FUNCTION_APP --resource-group $RESOURCE_GROUP
```

### View Event Grid Metrics

**Azure Portal**:
1. Storage Account → Events → Event Subscriptions
2. Click subscription → Metrics
3. Check "Publish Success Rate" and "Delivery Success Rate"

### Common Issues

#### Issue: Event Grid not triggering

**Solution**:
```bash
# Verify Event Subscription is active
az eventgrid event-subscription show \
  --name habitat-blob-processing \
  --query provisioningState

# Check endpoint validation
az eventgrid event-subscription show \
  --name habitat-blob-processing \
  --query "destination.properties.endpointUrl"
```

#### Issue: SAS Token expired

**Solution**: Check system time is synchronized
```bash
# Windows
w32tm /query /status

# Azure Function - check WEBSITE_TIME_ZONE setting
az functionapp config appsettings set \
  --name $FUNCTION_APP \
  --settings "WEBSITE_TIME_ZONE=UTC"
```

#### Issue: AI Vision API error

**Solution**: Verify endpoint and key
```bash
# Test AI Vision endpoint
curl -X POST "https://your-vision.cognitiveservices.azure.com/computervision/imageanalysis:analyze?api-version=2023-02-01-preview&features=caption" \
  -H "Ocp-Apim-Subscription-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/test-image.jpg"}'
```

## Performance Testing

### Load Test with Apache Bench

```bash
# Test SAS Token Generation
ab -n 1000 -c 10 -p upload-request.json -T application/json \
  http://localhost:7071/api/GetUploadUrl
```

**Expected Results**:
- Requests per second: > 100
- Mean response time: < 100ms
- No failures

### Stress Test Event Grid

```bash
# Upload multiple files simultaneously
for i in {1..10}; do
  curl -X POST http://localhost:7071/api/GetUploadUrl \
    -H "Content-Type: application/json" \
    -d "{\"filename\": \"test$i.jpg\", \"filetype\": \"image/jpeg\"}" &
done
wait
```

## Cost Estimation

### Monthly Cost (Estimated for 10,000 uploads/month)

| Service | Usage | Cost |
|---------|-------|------|
| Azure Functions | 10,000 executions × 3 functions | $0.20 |
| Blob Storage | 10GB storage + operations | $0.50 |
| Cosmos DB | 400 RU/s autoscale | $23.00 |
| Event Grid | 10,000 events | $0.01 |
| AI Vision | 10,000 API calls | $15.00 |
| **Total** | | **~$39/month** |

### Cost Optimization Tips
1. Use Blob Lifecycle Management (move to Cool tier after 30 days)
2. Enable Cosmos DB autoscale (scale down during low usage)
3. Batch AI Vision requests if possible
4. Use CDN for frequently accessed images

## Security Checklist

- [ ] Enable HTTPS only for Function App
- [ ] Configure CORS for production domain
- [ ] Enable Azure AD authentication
- [ ] Implement API rate limiting
- [ ] Enable Application Insights
- [ ] Configure Azure Key Vault for secrets
- [ ] Enable diagnostic logs
- [ ] Set up Azure Monitor alerts

## Next Steps

1. **Enable Authentication**: Add Azure AD B2C for user login
2. **Real-time Updates**: Implement SignalR for live processing status
3. **Video Processing**: Integrate Azure Video Indexer
4. **Logic Apps**: Create visual workflows for CRUD operations
5. **Monitoring**: Set up Application Insights dashboards
6. **CI/CD**: Implement GitHub Actions for automated deployment
