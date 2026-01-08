import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING!);
const database = client.database("habitat-db");
const container = database.container("observations");

export async function GetObservations(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    try {
        // SQL Query to get all items, sorted by newest first
        const querySpec = {
            query: "SELECT * FROM c ORDER BY c.timestamp DESC"
        };

        const { resources: items } = await container.items.query(querySpec).fetchAll();

        return {
            status: 200,
            jsonBody: items
        };

    } catch (error) {
        context.error(`Error fetching data: ${(error as Error).message}`);
        return { status: 500, body: "Error retrieving observations" };
    }
}

app.http('GetObservations', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: GetObservations
});
