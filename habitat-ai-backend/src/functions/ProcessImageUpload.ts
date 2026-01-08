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
        const isImage = ['.jpg', '.jpeg', '.png'].includes(extension);

        let aiData = { description: "Multimedia Content", tags: ["media"], confidence: 1.0 };

        if (isImage && process.env.AI_VISION_ENDPOINT && process.env.AI_VISION_KEY) {
            try {
                // Remove trailing slash from endpoint if present
                const endpoint = process.env.AI_VISION_ENDPOINT.replace(/\/$/, "");
                const aiUrl = `${endpoint}/computervision/imageanalysis:analyze?api-version=2023-02-01-preview&features=tags,caption`;

                const aiResponse = await axios.post(aiUrl, blob, {
                    headers: {
                        'Ocp-Apim-Subscription-Key': process.env.AI_VISION_KEY,
                        'Content-Type': 'application/octet-stream'
                    }
                });

                aiData = {
                    description: aiResponse.data.captionResult.text,
                    tags: aiResponse.data.tagsResult.values.map((t: any) => t.name),
                    confidence: aiResponse.data.captionResult.confidence
                };
            } catch (e) { context.error("AI Analysis Failed"); }
        } else {
            // Mock Data for Video/Audio
            if (['.mp3', '.wav'].includes(extension)) aiData = { description: "Audio Recording", tags: ["audio"], confidence: 1 };
            if (['.mp4', '.mov'].includes(extension)) aiData = { description: "Video Recording", tags: ["video"], confidence: 1 };
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
