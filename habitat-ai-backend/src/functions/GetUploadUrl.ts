import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from "@azure/storage-blob";

export async function GetUploadUrl(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log('Generating Secure SAS Token for upload...');

    try {
        // 1. Parse Connection String (Robust Fix)
        const connString = process.env.AzureWebJobsStorage;
        if (!connString) throw new Error("AzureWebJobsStorage is missing!");

        // Extract Account Name and Key using Regex
        const nameMatch = connString.match(/AccountName=([^;]+)/);
        const keyMatch = connString.match(/AccountKey=([^;]+)/);

        if (!nameMatch || !keyMatch) {
            throw new Error("Invalid Connection String. Could not parse AccountName or AccountKey.");
        }

        const accountName = nameMatch[1];
        const accountKey = keyMatch[1];

        // 2. Setup Client
        const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
        
        // 3. Parse Request
        const body = await request.json() as { filename?: string; filetype?: string };
        const filename = body.filename;
        const filetype = body.filetype; 

        if (!filename || !filetype) {
            return { status: 400, jsonBody: { error: "Filename and filetype are required" } };
        }

        // 4. Generate SAS
        const uniqueBlobName = `${Date.now()}-${filename}`;
        const containerName = "raw-uploads";

        const sasOptions = {
            containerName,
            blobName: uniqueBlobName,
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + 5 * 60 * 1000), 
            permissions: BlobSASPermissions.parse("cwt") // Create, Write, Tag
        };

        const sasToken = generateBlobSASQueryParameters(sasOptions, sharedKeyCredential).toString();
        const uploadUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${uniqueBlobName}?${sasToken}`;

        return {
            jsonBody: {
                uploadUrl: uploadUrl,
                blobName: uniqueBlobName,
                message: "Ready to upload"
            }
        };

    } catch (error) {
        context.error(`Error generating SAS: ${(error as Error).message}`);
        return { status: 500, jsonBody: { error: "Internal Server Error" } };
    }
}

app.http('GetUploadUrl', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: GetUploadUrl
});
