import { app, InvocationContext, EventGridEvent } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";
import axios from 'axios';
import * as path from 'path';

/**
 * EVENT-DRIVEN ARCHITECTURE: This function uses Event Grid instead of Blob Trigger
 * Benefits:
 * 1. Decoupling: Upload and processing are separate concerns
 * 2. Scalability: Event Grid handles millions of events/sec
 * 3. Reliability: Built-in retry and dead-lettering
 * 4. Flexibility: Multiple subscribers can listen to the same event
 */

// Initialize Azure Service Clients using Environment Variables
const cosmosClient = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING!);
const container = cosmosClient.database("habitat-db").container("observations");
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage!);

export async function EventGridProcessImage(event: EventGridEvent, context: InvocationContext): Promise<void> {
    context.log('=== Event Grid Trigger Fired ===');
    context.log(`Event Type: ${event.eventType}`);
    context.log(`Event Subject: ${event.subject}`);

    try {
        // 1. Validate Event Type (only process blob creation events)
        if (event.eventType !== 'Microsoft.Storage.BlobCreated') {
            context.log(`Ignoring event type: ${event.eventType}`);
            return;
        }

        // 2. Parse Event Data to extract Blob information
        const blobUrl = event.data.url as string;
        const blobName = path.basename(blobUrl);

        context.log(`Processing blob: ${blobName}`);
        context.log(`Blob URL: ${blobUrl}`);

        // 3. Download the Blob from Storage
        // WHY: We need the actual file content to send to AI Vision API
        const containerClient = blobServiceClient.getContainerClient("raw-uploads");
        const blobClient = containerClient.getBlobClient(blobName);

        const downloadResponse = await blobClient.download();
        const blobBuffer = await streamToBuffer(downloadResponse.readableStreamBody!);

        context.log(`Downloaded blob, size: ${blobBuffer.length} bytes`);

        // 4. Extract Metadata (User, Location, GPS, Description if available)
        let location = "Unknown";
        let userId = "demo-user"; // Default user for this demo
        let userDescription = "User Observation"; // NEW: User's description
        let lat = 54.5973; // Default: Belfast, Northern Ireland
        let lng = -5.9301;

        try {
            const properties = await blobClient.getProperties();
            const meta = properties.metadata || {};

            location = decodeURIComponent(meta.location || "Unknown");
            userId = decodeURIComponent(meta.uploadedby || userId);
            userDescription = decodeURIComponent(meta.description || "User Observation"); // NEW: Capture description from metadata
            if (meta.lat) lat = parseFloat(meta.lat);
            if (meta.lng) lng = parseFloat(meta.lng);

            context.log(`Metadata - User: ${userId}, Location: ${location}, Description: ${userDescription}`);
        } catch (e) {
            context.log("Metadata read failed, using defaults");
        }

        // 5. Determine File Type
        const extension = path.extname(blobName).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp'].includes(extension);
        const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(extension);
        const isAudio = ['.mp3', '.wav', '.m4a', '.ogg'].includes(extension);

        // 6. AI Analysis using Azure Computer Vision 4.0
        let aiData = {
            description: "Awaiting AI Insights...",
            tags: ["wildlife", "nature"],
            confidence: 0.0
        };

        if (isImage && process.env.AI_VISION_ENDPOINT && process.env.AI_VISION_KEY) {
            try {
                context.log('--- Calling Azure AI Vision 4.0 (Global Wildlife Model) ---');

                const endpoint = process.env.AI_VISION_ENDPOINT.replace(/\/$/, "");
                const aiUrl = `${endpoint}/computervision/imageanalysis:analyze?api-version=2023-10-01&features=caption,tags`;

                const aiResponse = await axios.post(aiUrl, blobBuffer, {
                    headers: {
                        'Ocp-Apim-Subscription-Key': process.env.AI_VISION_KEY!,
                        'Content-Type': 'application/octet-stream'
                    },
                    timeout: 45000
                });

                const analysis = aiResponse.data;
                const rawTags = analysis.tagsResult?.values?.map((t: any) => t.name.toLowerCase()) || [];
                const caption = analysis.captionResult?.text || "Nature Observation";

                // ENHANCED SPECIES CATALOGUE WITH CLASSIFICATION
                const birdSpecies = ['stork', 'heron', 'eagle', 'hawk', 'owl', 'pigeon', 'swallow', 'swan', 'duck', 'goose', 'sparrow', 'robin', 'penguin', 'crow', 'raven', 'seagull', 'pelican', 'flamingo', 'peacock', 'parrot', 'woodpecker', 'kingfisher'];
                const mammalSpecies = ['deer', 'fox', 'squirrel', 'rabbit', 'bear', 'wolf', 'cat', 'dog', 'elephant', 'lion', 'tiger', 'zebra', 'giraffe', 'monkey', 'otter', 'seal', 'dolphin', 'whale'];
                const reptileSpecies = ['snake', 'lizard', 'turtle', 'tortoise', 'crocodile', 'alligator', 'iguana', 'gecko'];
                const amphibianSpecies = ['frog', 'toad', 'salamander', 'newt'];
                const fishSpecies = ['salmon', 'trout', 'bass', 'pufferfish', 'goldfish', 'shark', 'ray'];
                const insectSpecies = ['butterfly', 'bee', 'beetle', 'ant', 'dragonfly', 'ladybug', 'moth', 'wasp'];
                
                const allSpecies = [...birdSpecies, ...mammalSpecies, ...reptileSpecies, ...amphibianSpecies, ...fishSpecies, ...insectSpecies];
                const detected = rawTags.find((t: string) => allSpecies.includes(t));
                
                // Determine classification
                let classification = '';
                if (detected) {
                    if (birdSpecies.includes(detected)) classification = 'Bird';
                    else if (mammalSpecies.includes(detected)) classification = 'Mammal';
                    else if (reptileSpecies.includes(detected)) classification = 'Reptile';
                    else if (amphibianSpecies.includes(detected)) classification = 'Amphibian';
                    else if (fishSpecies.includes(detected)) classification = 'Fish';
                    else if (insectSpecies.includes(detected)) classification = 'Insect';
                }

                let finalDesc = caption;
                if (detected && classification) {
                    // Scientific species identification with classification
                    finalDesc = `${classification} Species: ${detected.charAt(0).toUpperCase() + detected.slice(1)} | ${caption}`;
                } else if (rawTags.includes('bird')) {
                    finalDesc = `Bird Observation: ${caption}`;
                } else if (rawTags.includes('animal') || rawTags.includes('wildlife')) {
                    finalDesc = `Wildlife Detected: ${caption}`;
                } else if (rawTags.includes('insect')) {
                    finalDesc = `Insect Species: ${caption}`;
                } else {
                    finalDesc = `Environmental Observation: ${caption}`;
                }

                // Filtering for high-quality tags only
                const academicTags = rawTags.filter((t: string) => !['media', 'image', 'picture', 'photo', 'indoor', 'outdoor'].includes(t));

                aiData = {
                    description: finalDesc,
                    tags: academicTags.slice(0, 8),
                    confidence: analysis.captionResult?.confidence || 0.8
                };

                context.log(`✅ AI Analysis Completed: ${aiData.description}`);
            } catch (aiError: any) {
                const errorMessage = aiError.response?.data?.error?.message || aiError.message;
                context.error(`❌ AI Analytics Failed: ${errorMessage}`);
                if (aiError.response) {
                    context.error(`Status: ${aiError.response.status}`);
                    context.error(`Details: ${JSON.stringify(aiError.response.data)}`);
                }
                aiData.description = "Nature Record Generated";
            }
        } else if (isVideo) {
            aiData = { description: "Video Recording", tags: ["video", "wildlife"], confidence: 1.0 };
        } else if (isAudio) {
            aiData = { description: "Audio Recording", tags: ["audio", "nature"], confidence: 1.0 };
        }

        // 7. Get Storage Account Name for constructing public URL
        const connString = process.env.AzureWebJobsStorage!;
        const accountName = connString.match(/AccountName=([^;]+)/)?.[1] || "unknown";

        // 8. Construct the Observation Document
        const observation = {
            id: blobName, // Use blob name as unique ID
            userId: userId, // Partition key
            location: location,
            userDescription: userDescription, // NEW: Store user's description
            coordinates: { lat, lng },
            timestamp: new Date().toISOString(),
            imageUrl: `https://${accountName}.blob.core.windows.net/raw-uploads/${blobName}`,
            type: isImage ? 'image' : (isVideo ? 'video' : 'audio'),
            aiData: aiData,
            processedBy: 'EventGrid', // Track which processor handled this
            eventGridEventId: event.id // Store event ID for traceability
        };

        // 9. Upsert to Cosmos DB
        // WHY UPSERT: If the same file is uploaded twice, we update rather than duplicate
        await container.items.upsert(observation);

        context.log(`✅ Successfully saved observation to Cosmos DB`);
        context.log(`Document ID: ${observation.id}`);

    } catch (error) {
        // Robust Error Handling
        context.error(`❌ Error processing Event Grid event: ${(error as Error).message}`);
        context.error(`Stack: ${(error as Error).stack}`);

        // In production, you might want to:
        // - Send to dead-letter queue
        // - Create alert in Application Insights
        // - Store failed event for manual retry
        throw error; // Re-throw to trigger Event Grid retry mechanism
    }
}

/**
 * Helper function to convert ReadableStream to Buffer
 * Required because Azure AI Vision expects a Buffer, not a stream
 */
async function streamToBuffer(readableStream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        readableStream.on('data', (data: Buffer) => {
            chunks.push(data);
        });
        readableStream.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on('error', reject);
    });
}

/**
 * DISABLED: Using ProcessImageUpload.ts (Blob Trigger) instead.
 * Having both triggers active causes duplicates.
 */
/*
app.eventGrid('EventGridProcessImage', {
    handler: EventGridProcessImage
});
*/
