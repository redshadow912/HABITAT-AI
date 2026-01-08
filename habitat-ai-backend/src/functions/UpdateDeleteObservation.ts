import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";

// 1. Setup Cosmos DB
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING!);
const database = client.database("habitat-db");
const container = database.container("observations");

// 2. Setup Blob Storage
// CRITICAL: This assumes 'AzureWebJobsStorage' in local.settings.json is the full Connection String!
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage!);
const containerClient = blobServiceClient.getContainerClient("raw-uploads");

// DELETE Endpoint
app.http('DeleteObservation', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'observations/{id}/{userId}',
    handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
        // FIX 1: Decode the ID to handle spaces (e.g. 'Blue%20Bird.jpg' -> 'Blue Bird.jpg')
        const id = decodeURIComponent(request.params.id!);
        const userId = request.params.userId!;

        context.log(`[DELETE START] Attempting to delete: ${id}`);

        try {
            // --- Step A: Delete from Blob Storage ---
            const blockBlobClient = containerClient.getBlockBlobClient(id);
            
            // Check if it exists before trying to delete (helps debugging)
            const exists = await blockBlobClient.exists();
            context.log(`[STORAGE CHECK] Does blob '${id}' exist? ${exists}`);

            if (exists) {
                await blockBlobClient.delete();
                context.log(`[STORAGE DELETE] Blob '${id}' successfully deleted.`);
            } else {
                context.log(`[STORAGE WARNING] Could not find blob '${id}' in 'raw-uploads'. Skipping storage delete.`);
            }

            // --- Step B: Delete from Cosmos DB ---
            await container.item(id, userId).delete();
            context.log(`[DB DELETE] Metadata for '${id}' deleted from Cosmos DB.`);

            return { 
                status: 200, 
                jsonBody: { message: "File and Record deleted successfully" } 
            };

        } catch (error) {
            context.error(`[DELETE FAILED] Error: ${(error as Error).message}`);
            return { 
                status: 500, 
                jsonBody: { error: (error as Error).message } 
            };
        }
    }
});

// UPDATE Endpoint
app.http('UpdateObservation', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'observations/{id}',
    handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
        try {
            const id = decodeURIComponent(request.params.id!);
            const body = await request.json() as { userId?: string; description?: string; userDescription?: string; location?: string; coordinates?: { lat: number; lng: number } };
            
            // Debug logging
            context.log(`UpdateObservation called with ID: ${id}`);
            context.log(`Request body: ${JSON.stringify(body)}`);
            context.log(`Coordinates received: ${JSON.stringify(body.coordinates)}`);
            context.log(`Has coordinates: ${!!body.coordinates}`);
            
            // Get item using provided userId or query across partitions
            let item: any;
            context.log(`Looking up item with ID: ${id}`);
            
            if (body.userId) {
                context.log(`Using userId for direct lookup: ${body.userId}`);
                try {
                    const { resource } = await container.item(id, body.userId).read();
                    item = resource;
                    context.log(`Direct lookup successful: ${!!item}`);
                } catch (lookupError) {
                    context.log(`Direct lookup failed: ${lookupError}`);
                    item = null;
                }
            } 
            
            if (!item) {
                context.log(`Falling back to cross-partition query`);
                // Fallback: Query across all partitions (less efficient)
                const querySpec = {
                    query: "SELECT * FROM c WHERE c.id = @id",
                    parameters: [{ name: "@id", value: id }]
                };
                const { resources } = await container.items.query(querySpec).fetchAll();
                item = resources[0];
                context.log(`Cross-partition query found ${resources.length} items`);
            }
            
            if (!item) {
                return { status: 404, body: "Item not found" };
            }

            // Update allowed fields
            if (body.description) item.aiData.description = body.description; // Update Species Name
            if (body.userDescription !== undefined) item.userDescription = body.userDescription; // Update Observer Notes
            if (body.location) item.location = body.location;                 // Update Location
            if (body.coordinates) {
                item.coordinates = body.coordinates;        // Update Coordinates for map positioning
                context.log(`Updated coordinates to: ${JSON.stringify(body.coordinates)}`);
            } else {
                context.log(`No coordinates provided, keeping existing: ${JSON.stringify(item.coordinates)}`);
            }
            
            item.status = "user-verified";

            await container.items.upsert(item);

            return { 
                status: 200, 
                jsonBody: { message: "Updated", item } 
            };
        } catch (error) {
            return { 
                status: 500, 
                jsonBody: { error: "Update failed" } 
            };
        }
    }
});
