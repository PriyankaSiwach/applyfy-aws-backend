import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDBClient({});
const RESUMES_TABLE_NAME = process.env.RESUMES_TABLE_NAME;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
};

interface ApiGatewayEvent {
  pathParameters?: Record<string, string | undefined> | null;
  httpMethod?: string;
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/** resumeId is the S3 object key ("{uuid}-{filename}"), so clients must URL-encode it. */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export const handler = async (event: ApiGatewayEvent) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  if (!RESUMES_TABLE_NAME) {
    return jsonResponse(500, { error: 'RESUMES_TABLE_NAME is not configured' });
  }

  const rawId = event.pathParameters?.id;
  if (!rawId || !rawId.trim()) {
    return jsonResponse(400, { error: 'Path parameter "id" is required' });
  }
  const resumeId = decodeId(rawId.trim());

  try {
    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: RESUMES_TABLE_NAME,
        Key: { resumeId: { S: resumeId } },
      }),
    );

    const item = result.Item;
    if (!item) {
      return jsonResponse(404, { error: 'Resume not found', resumeId });
    }

    return jsonResponse(200, {
      resumeId: item.resumeId?.S ?? resumeId,
      extractedText: item.extractedText?.S ?? '',
      filename: item.filename?.S ?? '',
      charLength: Number(item.charLength?.N ?? 0),
      uploadedAt: item.uploadedAt?.S ?? '',
    });
  } catch (err) {
    console.error('GetItem failed', { resumeId, error: String(err) });
    return jsonResponse(500, { error: 'Could not load resume' });
  }
};
