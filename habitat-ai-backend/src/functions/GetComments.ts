import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING!);
const database = client.database("habitat-db");
const container = database.container("comments");

export async function GetComments(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const observationId = request.params.observationId;
    context.log(`Fetching comments for observation: ${observationId}`);

    try {
        const querySpec = {
            query: "SELECT * FROM c WHERE c.observationId = @observationId ORDER BY c.timestamp DESC",
            parameters: [
                { name: "@observationId", value: observationId }
            ]
        };

        const { resources: comments } = await container.items.query(querySpec).fetchAll();

        return {
            status: 200,
            body: JSON.stringify(comments),
            headers: {
                'Content-Type': 'application/json'
            }
        };
    } catch (error) {
        context.error(`Error fetching comments: ${error}`);
        return {
            status: 500,
            body: "Internal Server Error"
        };
    }
};

app.http('GetComments', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'observations/{observationId}/comments',
    handler: GetComments
});
