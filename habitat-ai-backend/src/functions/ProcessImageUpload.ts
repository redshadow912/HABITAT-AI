import { app, InvocationContext } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";
import axios from 'axios';
import * as path from 'path';

// Setup Clients
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING!);
const container = client.database("habitat-db").container("observations");
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage!);
const containerClient = blobServiceClient.getContainerClient("raw-uploads");

export async function ProcessImageUpload(blob: Buffer, context: InvocationContext): Promise<void> {
    const filename = context.triggerMetadata.name as string;
    context.log(`Processing file: ${filename}`);

    try {
        // 1. Get Account Name for URL (Fixing the undefined bug)
        const connString = process.env.AzureWebJobsStorage!;
        const accountName = connString.match(/AccountName=([^;]+)/)?.[1] || "unknown";

        // 2. Fetch Metadata (GPS/User)
        let location = "Unknown";
        let user = "Anonymous";
        let lat = 54.5973;
        let lng = -5.9301;
        let userDescription = "";

        try {
            const blobClient = containerClient.getBlobClient(filename);
            const properties = await blobClient.getProperties();
            const meta = properties.metadata || {};

            location = decodeURIComponent(meta.location || "Unknown");
            user = meta.uploadedby || "Anonymous";
            userDescription = decodeURIComponent(meta.userdescription || "");

            if (meta.lat) lat = parseFloat(meta.lat);
            if (meta.lng) lng = parseFloat(meta.lng);

        } catch (e) { context.log("Metadata read failed, using defaults."); }

        // 3. AI Analysis
        const extension = path.extname(filename).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(extension);

        let aiData = {
            description: "Multimedia Content",
            tags: ["media"],
            confidence: 1.0,
            species: "Unknown",
            objects: [] as string[]
        };

        if (isImage && process.env.AI_VISION_ENDPOINT && process.env.AI_VISION_KEY) {
            try {
                const endpoint = process.env.AI_VISION_ENDPOINT.replace(/\/$/, "");
                // Using v3.2 API - much more stable for regions like Poland Central
                const aiUrl = `${endpoint}/vision/v3.2/analyze?visualFeatures=Description,Tags,Objects`;

                context.log(`[AI] Processing: ${filename}`);

                const aiResponse = await axios.post(aiUrl, blob, {
                    headers: {
                        'Ocp-Apim-Subscription-Key': process.env.AI_VISION_KEY,
                        'Content-Type': 'application/octet-stream'
                    }
                });

                const data = aiResponse.data;
                const topCaption = data.description?.captions?.[0];

                aiData = {
                    description: topCaption?.text || "Wilderness Observation",
                    tags: (data.tags || []).map((t: any) => t.name),
                    confidence: topCaption?.confidence || 0,
                    species: (data.tags || []).find((t: any) => t.confidence > 0.85)?.name || "Unknown",
                    objects: (data.objects || []).map((o: any) => o.object)
                };
                context.log(`[AI] Success: ${aiData.description}`);
            } catch (e) {
                context.error(`[AI] Failed for ${filename}. Details: ${e.message}`);
                if (e.response) context.error(`[AI] Status: ${e.response.status}, Reply: ${JSON.stringify(e.response.data)}`);
            }
        } else {
            context.log(`[AI] Skipping: ${!isImage ? 'Not an image' : 'Credentials missing in Azure configuration'}`);
            if (['.mp3', '.wav'].includes(extension)) aiData = { description: "Audio Recording", tags: ["audio"], confidence: 1, species: "Audio", objects: [] };
            if (['.mp4', '.mov'].includes(extension)) aiData = { description: "Video Recording", tags: ["video"], confidence: 1, species: "Video", objects: [] };
        }

        // 4. Save to Cosmos DB
        const newObservation = {
            id: filename,
            userId: user,
            location: location,
            coordinates: { lat, lng },
            timestamp: new Date().toISOString(),
            // URL IS FIXED HERE:
            imageUrl: `https://${accountName}.blob.core.windows.net/raw-uploads/${filename}`,
            type: isImage ? 'image' : (['.mp4', '.mov'].includes(extension) ? 'video' : 'audio'),
            userDescription: userDescription,
            aiData: aiData
        };

        await container.items.upsert(newObservation);
        context.log("Saved to Cosmos DB.");

    } catch (error) {
        context.error(`Error: ${(error as Error).message}`);
    }
}

app.storageBlob('ProcessImageUpload', {
    path: 'raw-uploads/{name}', // Triggers when file hits this container
    connection: 'AzureWebJobsStorage',
    handler: ProcessImageUpload
});
