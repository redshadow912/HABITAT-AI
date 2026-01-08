import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING!);
const database = client.database("habitat-db");
const container = database.container("comments");

export async function AddComment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);

    try {
        const body: any = await request.json();
        const { observationId, userId, comment } = body;

        if (!observationId || !userId || !comment) {
            return {
                status: 400,
                body: "Missing required fields: observationId, userId, comment"
            };
        }

        const newComment = {
            id: Date.now().toString(),
            observationId,
            userId,
            comment,
            timestamp: new Date().toISOString()
        };

        await container.items.create(newComment);

        return {
            status: 201,
            body: JSON.stringify(newComment),
            headers: {
                'Content-Type': 'application/json'
            }
        };
    } catch (error) {
        context.error(`Error adding comment: ${error}`);
        return {
            status: 500,
            body: "Internal Server Error"
        };
    }
};

app.http('AddComment', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'observations/{observationId}/comments',
    handler: AddComment
});
